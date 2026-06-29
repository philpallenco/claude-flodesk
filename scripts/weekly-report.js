/**
 * Weekly Flodesk → Slack report, written by Claude
 *
 * Required env vars:
 *   ANTHROPIC_API_KEY  — Anthropic API key
 *   FLODESK_API_KEY    — Flodesk public API key
 *   SLACK_BOT_TOKEN    — Slack bot token (chat:write scope)
 *   SLACK_CHANNEL_ID   — Target Slack channel ID
 */

import Anthropic from '@anthropic-ai/sdk';

const FLODESK_BASE = 'https://api.flodesk.com/v1';
const SLACK_POST   = 'https://slack.com/api/chat.postMessage';

const { ANTHROPIC_API_KEY, FLODESK_API_KEY, SLACK_BOT_TOKEN, SLACK_CHANNEL_ID } = process.env;

if (!ANTHROPIC_API_KEY || !FLODESK_API_KEY || !SLACK_BOT_TOKEN || !SLACK_CHANNEL_ID) {
  console.error('Missing required env vars');
  process.exit(1);
}

const flodeskAuth = 'Basic ' + Buffer.from(`${FLODESK_API_KEY}:`).toString('base64');
const anthropic   = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

function isoDate(d) {
  return d.toISOString().split('T')[0];
}

async function getFlodeskData() {
  const res = await fetch(`${FLODESK_BASE}/subscribers?per_page=1`, {
    headers: { Authorization: flodeskAuth },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Flodesk /subscribers → ${res.status}: ${text}`);
  }
  const json = await res.json();
  return {
    totalSubscribers: json.meta?.total_items ?? '—',
  };
}

async function generateReport(data, weekLabel) {
  const msg = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 512,
    messages: [{
      role: 'user',
      content: `Write a short, upbeat weekly email marketing summary for Slack.

Week: ${weekLabel}
Data available:
- Total active subscribers: ${data.totalSubscribers.toLocaleString()}

Guidelines:
- Open with one punchy sentence (e.g. "Your list keeps growing!")
- Show the subscriber count clearly
- Mention that open rates, click rates, and campaign stats are in the Flodesk dashboard
- End with a brief motivating note
- Use Slack markdown: *bold*, _italic_
- Keep it under 5 lines total — short and scannable`,
    }],
  });
  return msg.content[0].text;
}

async function postToSlack(reportText, weekLabel) {
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
      text: { type: 'mrkdwn', text: reportText },
    },
    { type: 'divider' },
    {
      type: 'context',
      elements: [{
        type: 'mrkdwn',
        text: 'Open rates · Click rates · Campaign stats → <https://app.flodesk.com/analytics|Flodesk Analytics>',
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
  const today   = new Date();
  const weekAgo = new Date(today);
  weekAgo.setDate(today.getDate() - 7);
  const weekLabel = `${isoDate(weekAgo)} – ${isoDate(today)}`;

  console.log('Fetching Flodesk data…');
  const data = await getFlodeskData();
  console.log('Subscribers:', data.totalSubscribers);

  console.log('Generating report with Claude…');
  const reportText = await generateReport(data, weekLabel);
  console.log('Report:\n', reportText);

  console.log('Posting to Slack…');
  const result = await postToSlack(reportText, weekLabel);
  console.log('Posted. ts:', result.ts);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
