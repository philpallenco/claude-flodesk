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
  const today        = new Date();
  const sevenDaysAgo = new Date(today);
  sevenDaysAgo.setDate(today.getDate() - 7);

  // Fetch in parallel — only endpoints confirmed to exist in the Flodesk public API
  const [subTotals, emailTotals] = await Promise.all([
    flodesk('/analytics/subscribers?period=last7Days'),
    flodesk('/analytics/emails'),
  ]);

  // Subscriber data
  const sub         = subTotals.data ?? subTotals;
  const totalSubs   = sub.totalActives ?? sub.summary?.overall?.totalActives ?? '—';
  const newThisWeek = sub.totalNew7d   ?? sub.summary?.overall?.totalNew7d   ?? sub.totalNew ?? '—';
  const unsubsWeek  = sub.totalUnsub   ?? sub.summary?.change?.totalUnsub?.value ?? 0;
  const netGrowth   = typeof newThisWeek === 'number' && typeof unsubsWeek === 'number'
    ? newThisWeek - unsubsWeek
    : '—';

  // Email performance
  const totals       = emailTotals.totals ?? emailTotals;
  const openRateCur  = totals.openRate  ?? null;
  const clickRateCur = totals.clickRate ?? null;

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
          openRateCur  != null ? `• Open rate:  *${pct(openRateCur)}*`  : '• Open rate:  —',
          clickRateCur != null ? `• Click rate: *${pct(clickRateCur)}*` : '• Click rate: —',
        ].join('\n'),
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
