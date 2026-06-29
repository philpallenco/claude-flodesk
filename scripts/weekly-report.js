/**
 * Weekly Flodesk → Slack report
 * Fetches subscriber growth, email performance, and top campaigns from the
 * Flodesk REST API, then posts a Block Kit summary to Slack.
 *
 * Required env vars: FLODESK_API_KEY, SLACK_BOT_TOKEN, SLACK_CHANNEL_ID
 */

const FLODESK_BASE = 'https://api.flodesk.com/v1';
const SLACK_POST  = 'https://slack.com/api/chat.postMessage';

const { FLODESK_API_KEY, SLACK_BOT_TOKEN, SLACK_CHANNEL_ID } = process.env;

if (!FLODESK_API_KEY || !SLACK_BOT_TOKEN || !SLACK_CHANNEL_ID) {
  console.error('Missing required env vars: FLODESK_API_KEY, SLACK_BOT_TOKEN, SLACK_CHANNEL_ID');
  process.exit(1);
}

// Flodesk uses HTTP Basic auth: apiKey as username, empty password
const flodeskAuth = 'Basic ' + Buffer.from(`${FLODESK_API_KEY}:`).toString('base64');

function isoDate(d) {
  return d.toISOString().split('T')[0];
}

function pct(decimal) {
  return (decimal * 100).toFixed(1) + '%';
}

function delta(current, previous) {
  if (previous == null || previous === 0) return '';
  const diff = current - previous;
  const sign = diff >= 0 ? '+' : '';
  return ` (${sign}${pct(diff)} vs last week)`;
}

async function flodesk(path) {
  const res = await fetch(`${FLODESK_BASE}${path}`, {
    headers: { Authorization: flodeskAuth, 'Content-Type': 'application/json' },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Flodesk ${path} → ${res.status}: ${text}`);
  }
  return res.json();
}

async function buildReport() {
  const today     = new Date();
  const sevenDaysAgo = new Date(today);
  sevenDaysAgo.setDate(today.getDate() - 7);
  const fourteenDaysAgo = new Date(today);
  fourteenDaysAgo.setDate(today.getDate() - 14);

  const weekFrom = isoDate(sevenDaysAgo);
  const prevFrom = isoDate(fourteenDaysAgo);
  const weekTo   = isoDate(today);

  // Fetch in parallel — subscriber totals include 7-day new/unsub vs prior period
  const [subTotals, emailTotals, topEmails, weekTrends, prevTrends] =
    await Promise.all([
      flodesk('/analytics/subscribers?period=last7Days'),
      flodesk('/analytics/emails'),
      flodesk('/analytics/emails?orderBy=openRate&sort=desc&perPage=3'),
      flodesk(`/analytics/emails/trends?from=${weekFrom}&to=${weekTo}&interval=week`),
      flodesk(`/analytics/emails/trends?from=${prevFrom}&to=${weekFrom}&interval=week`),
    ]);

  // Subscriber data — Flodesk returns these fields at the top level or under data
  const sub          = subTotals.data ?? subTotals;
  const totalSubs    = sub.totalActives   ?? '—';
  const newThisWeek  = sub.totalNew       ?? sub.newSubscribers   ?? '—';
  const unsubsWeek   = sub.totalUnsub     ?? sub.totalUnsubscribed ?? 0;
  const netGrowth    = typeof newThisWeek === 'number' && typeof unsubsWeek === 'number'
    ? newThisWeek - unsubsWeek
    : '—';

  // Email performance (current week vs prior week)
  const currentWeek = weekTrends.data?.[0]  ?? {};
  const priorWeek   = prevTrends.data?.[0]  ?? {};
  const openRateCur  = currentWeek.openRate  ?? emailTotals.openRate  ?? null;
  const clickRateCur = currentWeek.clickRate ?? emailTotals.clickRate ?? null;
  const openRatePrev  = priorWeek.openRate  ?? null;
  const clickRatePrev = priorWeek.clickRate ?? null;

  // Top campaigns
  const campaigns = (topEmails.data ?? []).slice(0, 3);

  // Build Slack Block Kit message
  const weekLabel = `${isoDate(sevenDaysAgo)} – ${isoDate(today)}`;
  const netSign   = typeof netGrowth === 'number' && netGrowth >= 0 ? '+' : '';

  const blocks = [
    {
      type: 'header',
      text: { type: 'plain_text', text: '📬 Weekly Flodesk Report', emoji: true },
    },
    {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `Week of ${weekLabel}` }],
    },
    { type: 'divider' },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Subscribers*\n• Total active: *${totalSubs.toLocaleString?.() ?? totalSubs}*\n• New this week: *${newThisWeek}*\n• Unsubscribed: *${unsubsWeek}*\n• Net growth: *${netSign}${netGrowth}*`,
      },
    },
    { type: 'divider' },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: [
          '*Email Performance*',
          openRateCur  != null ? `• Open rate:  *${pct(openRateCur)}*${delta(openRateCur, openRatePrev)}`   : '• Open rate:  —',
          clickRateCur != null ? `• Click rate: *${pct(clickRateCur)}*${delta(clickRateCur, clickRatePrev)}` : '• Click rate: —',
        ].join('\n'),
      },
    },
    { type: 'divider' },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: campaigns.length
          ? '*Top Campaigns by Open Rate*\n' +
            campaigns.map((c, i) => {
              const name = c.name ?? c.subject ?? `Campaign ${i + 1}`;
              const open = c.openRate  != null ? pct(c.openRate)  : '—';
              const click = c.clickRate != null ? pct(c.clickRate) : '—';
              return `${i + 1}. *${name}* — ${open} open · ${click} click`;
            }).join('\n')
          : '*Top Campaigns*\nNo campaign data available.',
      },
    },
  ];

  return {
    channel: SLACK_CHANNEL_ID,
    text: `Weekly Flodesk Report (${weekLabel})`,
    blocks,
  };
}

async function postToSlack(payload) {
  const res = await fetch(SLACK_POST, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  const json = await res.json();
  if (!json.ok) throw new Error(`Slack error: ${json.error}`);
  return json;
}

async function main() {
  console.log('Fetching Flodesk data…');
  const payload = await buildReport();
  console.log('Posting to Slack…');
  const result = await postToSlack(payload);
  console.log('Posted successfully. ts:', result.ts);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
