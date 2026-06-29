/**
 * Weekly Flodesk → Slack report, written by Claude
 *
 * Tracks subscriber history in data/history.json (committed back to the repo
 * each run) and uses Claude to analyse trends and generate recommendations.
 *
 * Required env vars:
 *   ANTHROPIC_API_KEY  — Anthropic API key
 *   FLODESK_API_KEY    — Flodesk public API key
 *   SLACK_BOT_TOKEN    — Slack bot token (chat:write scope)
 *   SLACK_CHANNEL_ID   — Target Slack channel ID
 */

import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HISTORY_PATH = resolve(__dirname, '../data/history.json');
const BRAND_PATH   = resolve(__dirname, '../brand.md');
const FLODESK_BASE = 'https://api.flodesk.com/v1';
const SLACK_POST   = 'https://slack.com/api/chat.postMessage';

const { ANTHROPIC_API_KEY, FLODESK_API_KEY, SLACK_BOT_TOKEN, SLACK_CHANNEL_ID } = process.env;

if (!ANTHROPIC_API_KEY || !FLODESK_API_KEY || !SLACK_BOT_TOKEN || !SLACK_CHANNEL_ID) {
  console.error('Missing required env vars');
  process.exit(1);
}

const flodeskAuth = 'Basic ' + Buffer.from(`${FLODESK_API_KEY}:`).toString('base64');
const anthropic   = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

function isoDate(d) { return d.toISOString().split('T')[0]; }

// --- Flodesk API helpers ---

async function fetchSubscriberCount(status = null) {
  const url = status
    ? `${FLODESK_BASE}/subscribers?status=${status}&per_page=1`
    : `${FLODESK_BASE}/subscribers?per_page=1`;
  const res = await fetch(url, { headers: { Authorization: flodeskAuth } });
  if (!res.ok) throw new Error(`Flodesk /subscribers${status ? '?status=' + status : ''} → ${res.status}`);
  const json = await res.json();
  return json.meta?.total_items ?? null;
}

async function getFlodeskSnapshot() {
  const totalActive = await fetchSubscriberCount();

  // Try to get unsubscribed count — may not be supported
  let totalUnsub = null;
  try {
    totalUnsub = await fetchSubscriberCount('unsubscribed');
  } catch {
    console.log('Unsub count not available via API — will use delta from history.');
  }

  return { totalActive, totalUnsub };
}

// --- History helpers ---

function loadHistory() {
  try {
    return JSON.parse(readFileSync(HISTORY_PATH, 'utf8'));
  } catch {
    return [];
  }
}

function saveHistory(history) {
  writeFileSync(HISTORY_PATH, JSON.stringify(history, null, 2));
}

function buildWeekEntry(date, snapshot, prev) {
  const netGrowth   = prev ? snapshot.totalActive - prev.totalActive : null;
  const unsubsDelta = (snapshot.totalUnsub != null && prev?.totalUnsub != null)
    ? snapshot.totalUnsub - prev.totalUnsub
    : null;
  const newSubs     = (netGrowth != null && unsubsDelta != null)
    ? netGrowth + unsubsDelta  // new = net + churned
    : netGrowth;               // fallback: net growth only

  return {
    date,
    totalActive:  snapshot.totalActive,
    totalUnsub:   snapshot.totalUnsub,
    netGrowth,
    newSubs,
    unsubsThisWeek: unsubsDelta,
  };
}

// --- Claude report generation ---

function loadBrandContext() {
  try {
    return readFileSync(BRAND_PATH, 'utf8');
  } catch {
    return '';
  }
}

async function generateReport(entry, history) {
  const recent = history.slice(-8); // last 8 weeks for context
  const brandContext = loadBrandContext();

  const historyText = recent.length > 1
    ? recent.map(w =>
        `${w.date}: ${w.totalActive.toLocaleString()} active` +
        (w.netGrowth != null ? `, net ${w.netGrowth >= 0 ? '+' : ''}${w.netGrowth}` : '') +
        (w.newSubs != null ? `, ${w.newSubs} new` : '') +
        (w.unsubsThisWeek != null ? `, ${w.unsubsThisWeek} unsubs` : '')
      ).join('\n')
    : 'First week of tracking — no prior history yet.';

  const thisWeek = `Date: ${entry.date}
Total active subscribers: ${entry.totalActive.toLocaleString()}
${entry.netGrowth != null ? `Net growth this week: ${entry.netGrowth >= 0 ? '+' : ''}${entry.netGrowth}` : ''}
${entry.newSubs != null ? `New subscribers: ${entry.newSubs}` : ''}
${entry.unsubsThisWeek != null ? `Unsubscribes: ${entry.unsubsThisWeek}` : ''}`.trim();

  const brandSection = brandContext
    ? `\nBRAND CONTEXT:\n${brandContext}\n`
    : '';

  const msg = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1200,
    messages: [{
      role: 'user',
      content: `You are an email marketing strategist for a personal branding creator. Write a detailed weekly Slack report using the brand context and subscriber data below.
${brandSection}
THIS WEEK:
${thisWeek}

HISTORY (oldest to newest):
${historyText}

Write a report with these sections. Use Slack mrkdwn only: *bold* and _italic_. Do NOT use ##, #, ---, or any Markdown that Slack doesn't support. Separate sections with a blank line only.

*📊 This week*
[key numbers with specific context — 2–3 lines]

*📈 Trend*
[honest analysis of the past 8 weeks with actual numbers — 2–3 lines]

*💡 Insight*
[one non-obvious observation about audience or list health, tied to the brand — 2 lines]

*✉️ Email idea*
[one specific campaign Phil could send this week; include a suggested subject line in quotes and a one-sentence angle — 2–3 lines]

*🎯 Lead magnet opportunity*
[one specific gap in the freebie lineup; name the topic and format — 2 lines]

*⚡ Action*
[the single most important thing to do this week — 1–2 lines]

Be specific to Phil Pallen's brand — never give generic advice. If it's the first week of tracking, skip Trend and just confirm tracking has started.`,
    }],
  });

  return msg.content[0].text;
}

// --- Slack ---

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
        text: 'Open rates · click rates · campaigns → <https://app.flodesk.com/analytics|Flodesk Analytics>',
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

// --- Main ---

async function main() {
  const today   = new Date();
  const weekAgo = new Date(today);
  weekAgo.setDate(today.getDate() - 7);
  const weekLabel = `${isoDate(weekAgo)} – ${isoDate(today)}`;
  const todayStr  = isoDate(today);

  console.log('Fetching Flodesk snapshot…');
  const snapshot = await getFlodeskSnapshot();
  console.log('Snapshot:', snapshot);

  const history = loadHistory();
  const prev    = history.at(-1) ?? null;
  const entry   = buildWeekEntry(todayStr, snapshot, prev);
  console.log('This week entry:', entry);

  // Replace any existing entry for today (prevents duplicates on re-runs)
  const idx = history.findIndex(w => w.date === todayStr);
  if (idx >= 0) {
    history[idx] = entry;
  } else {
    history.push(entry);
  }
  saveHistory(history);
  console.log(`History saved (${history.length} weeks).`);

  console.log('Generating report with Claude…');
  const reportText = await generateReport(entry, history);
  console.log('Report:\n', reportText);

  console.log('Posting to Slack…');
  const result = await postToSlack(reportText, weekLabel);
  console.log('Posted. ts:', result.ts);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
