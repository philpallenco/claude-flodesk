/**
 * Weekly Flodesk → Slack report
 *
 * Uses only Flodesk's public REST API (api.flodesk.com/v1).
 * Analytics endpoints are not public, so this report covers subscriber counts only.
 *
 * Required env vars: FLODESK_API_KEY, SLACK_BOT_TOKEN, SLACK_CHANNEL_ID
 */

const FLODESK_BASE = 'https://api.flodesk.com/v1';
const SLACK_POST   = 'https://slack.com/api/chat.postMessage';

const { FLODESK_API_KEY, SLACK_BOT_TOKEN, SLACK_CHANNEL_ID } = process.env;

if (!FLODESK_API_KEY || !SLACK_BOT_TOKEN || !SLACK_CHANNEL_ID) {
  console.error('Missing env vars: FLODESK_API_KEY, SLACK_BOT_TOKEN, SLACK_CHANNEL_ID');
  process.exit(1);
}

const flodeskAuth = 'Basic ' + Buffer.from(`${FLODESK_API_KEY}:`).toString('base64');

function isoDate(d) {
  return d.toISOString().split('T')[0];
}

async function getSubscriberCount() {
  const res = await fetch(`${FLODESK_BASE}/subscribers?per_page=1`, {
    headers: { Authorization: flodeskAuth },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Flodesk GET /subscribers → ${res.status}: ${text}`);
  }
  const json = await res.json();
  return json.meta?.total_items ?? '—';
}

async function postToSlack(message) {
  const today = new Date();
  const weekAgo = new Date(today);
  weekAgo.setDate(today.getDate() - 7);
  const weekLabel = `${isoDate(weekAgo)} – ${isoDate(today)}`;

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
        text: message,
      },
    },
    { type: 'divider' },
    {
      type: 'context',
      elements: [{
        type: 'mrkdwn',
        text: 'For open rates, click rates & campaign stats → <https://app.flodesk.com/analytics|Flodesk Analytics>',
      }],
    },
  ];

  const res = await fetch(SLACK_POST, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      channel: SLACK_CHANNEL_ID,
      text: `Weekly Flodesk Report (${weekLabel})`,
      blocks,
    }),
  });

  const json = await res.json();
  if (!json.ok) throw new Error(`Slack error: ${json.error}`);
  return json;
}

async function main() {
  console.log('Fetching subscriber count from Flodesk…');
  const total = await getSubscriberCount();
  console.log(`Total subscribers: ${total}`);

  const message = `*Subscribers*\n• Total active: *${typeof total === 'number' ? total.toLocaleString() : total}*`;

  console.log('Posting to Slack…');
  const result = await postToSlack(message);
  console.log('Posted successfully. ts:', result.ts);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
