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

async function flodeskGet(path) {
  const res = await fetch(`${FLODESK_BASE}${path}`, {
    headers: { Authorization: flodeskAuth },
  });
  if (!res.ok) throw new Error(`Flodesk ${path} → ${res.status} ${await res.text()}`);
  return res.json();
}

async function fetchSubscriberCount(status = null) {
  const qs  = status ? `?status=${status}&per_page=1` : '?per_page=1';
  const json = await flodeskGet(`/subscribers${qs}`);
  return json.meta?.total_items ?? null;
}

async function fetchSegments() {
  try {
    const json = await flodeskGet('/segments?per_page=20');
    return (json.data ?? []).map(s => ({
      name:         s.name,
      subscribersCount: s.subscribers_count ?? null,
    }));
  } catch (err) {
    console.log('Segments fetch failed:', err.message);
    return [];
  }
}

async function fetchRecentEmails(perPage = 5) {
  try {
    const json = await flodeskGet(`/emails?per_page=${perPage}&sort_by=sent_at&sort_order=desc`);
    return (json.data ?? []).map(e => ({
      subject:   e.subject ?? e.name,
      sentAt:    e.sent_at,
      openRate:  e.open_rate  != null ? `${(e.open_rate  * 100).toFixed(1)}%` : null,
      clickRate: e.click_rate != null ? `${(e.click_rate * 100).toFixed(1)}%` : null,
      sends:     e.total_sends ?? null,
    }));
  } catch (err) {
    console.log('Emails fetch failed:', err.message);
    return [];
  }
}

async function getFlodeskSnapshot() {
  const totalActive = await fetchSubscriberCount();

  let totalUnsub = null;
  try {
    totalUnsub = await fetchSubscriberCount('unsubscribed');
  } catch {
    console.log('Unsub count not available — will use delta from history.');
  }

  const [segments, recentEmails] = await Promise.all([
    fetchSegments(),
    fetchRecentEmails(5),
  ]);

  return { totalActive, totalUnsub, segments, recentEmails };
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
  const newSubs = (netGrowth != null && unsubsDelta != null)
    ? netGrowth + unsubsDelta
    : netGrowth;

  return {
    date,
    totalActive:    snapshot.totalActive,
    totalUnsub:     snapshot.totalUnsub,
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

async function generateReport(entry, history, snapshot) {
  const recent = history.slice(-8);
  const brandContext = loadBrandContext();

  const historyText = recent.length > 1
    ? recent.map(w =>
        `${w.date}: ${w.totalActive.toLocaleString()} active` +
        (w.netGrowth    != null ? `, net ${w.netGrowth >= 0 ? '+' : ''}${w.netGrowth}` : '') +
        (w.newSubs      != null ? `, ${w.newSubs} new` : '') +
        (w.unsubsThisWeek != null ? `, ${w.unsubsThisWeek} unsubs` : '')
      ).join('\n')
    : 'First week of tracking — no prior history yet.';

  const thisWeek = [
    `Date: ${entry.date}`,
    `Total active subscribers: ${entry.totalActive.toLocaleString()}`,
    entry.netGrowth    != null ? `Net growth this week: ${entry.netGrowth >= 0 ? '+' : ''}${entry.netGrowth}` : '',
    entry.newSubs      != null ? `New subscribers: ${entry.newSubs}` : '',
    entry.unsubsThisWeek != null ? `Unsubscribes: ${entry.unsubsThisWeek}` : '',
  ].filter(Boolean).join('\n');

  const segmentsText = snapshot.segments.length
    ? snapshot.segments
        .map(s => `  • ${s.name}: ${s.subscribersCount?.toLocaleString() ?? '?'} subs`)
        .join('\n')
    : '  (not available)';

  const emailsText = snapshot.recentEmails.length
    ? snapshot.recentEmails
        .map(e =>
          `  • "${e.subject}" sent ${e.sentAt ?? 'n/a'}` +
          (e.openRate  ? ` | open ${e.openRate}`  : '') +
          (e.clickRate ? ` | click ${e.clickRate}` : '') +
          (e.sends     ? ` | ${e.sends} sends`     : '')
        )
        .join('\n')
    : '  (not available)';

  const brandSection = brandContext ? `\nBRAND CONTEXT:\n${brandContext}\n` : '';

  const prompt = `You are an email marketing strategist for Phil Pallen, a personal branding educator. Write a weekly Slack digest using the data below.
${brandSection}
THIS WEEK:
${thisWeek}

SEGMENTS (top by size):
${segmentsText}

RECENT EMAILS (newest first):
${emailsText}

8-WEEK HISTORY (oldest → newest):
${historyText}

Write exactly 6 sections in this order. Use Slack mrkdwn ONLY: *bold* and _italic_. Do NOT use ##, #, ---, or any heading syntax. Separate sections with one blank line. No extra blank lines within a section.

*:bar_chart: This week* — key numbers with context (2–3 lines)

*:chart_with_upwards_trend: Trend* — 8-week analysis referencing real figures from the history above (2–3 lines)

*:bulb: Insight* — one non-obvious observation about audience or list health tied specifically to Phil's brand (2 lines)

*:email: Email idea* — one specific campaign Phil could send this week; include a suggested subject line in quotes and a one-sentence angle (2–3 lines)

*:dart: Lead magnet opportunity* — one specific gap in the freebie lineup; name the exact topic and format (2 lines)

*:zap: Action* — the single most important move this week (1–2 lines)

Rules:
- Every recommendation must be specific to Phil Pallen's personal branding audience, never generic.
- Reference real numbers from the data above — don't fabricate figures.
- If it's the first week of tracking, replace the Trend section with a note confirming tracking has started.
- Output only the six sections — no preamble, no sign-off.`;

  const msg = await anthropic.messages.create({
    model:      'claude-haiku-4-5-20251001',
    max_tokens: 1200,
    messages:   [{ role: 'user', content: prompt }],
  });

  return msg.content[0].text;
}

// --- Slack ---

async function postToSlack(reportText, weekLabel) {
  const blocks = [
    {
      type: 'header',
      text: { type: 'plain_text', text: ':postbox: Weekly Flodesk Report', emoji: true },
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
    method:  'POST',
    headers: {
      Authorization:  `Bearer ${SLACK_BOT_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      channel: SLACK_CHANNEL_ID,
      text:    `Weekly Flodesk Report (${weekLabel})`,
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
  console.log('Active subscribers:', snapshot.totalActive);
  console.log('Segments fetched:', snapshot.segments.length);
  console.log('Recent emails fetched:', snapshot.recentEmails.length);

  const history = loadHistory();
  const prev    = history.at(-1) ?? null;
  const entry   = buildWeekEntry(todayStr, snapshot, prev);
  console.log('This week entry:', entry);

  const idx = history.findIndex(w => w.date === todayStr);
  if (idx >= 0) {
    history[idx] = entry;
  } else {
    history.push(entry);
  }
  saveHistory(history);
  console.log(`History saved (${history.length} weeks).`);

  console.log('Generating report with Claude…');
  const reportText = await generateReport(entry, history, snapshot);
  console.log('Report:\n', reportText);

  console.log('Posting to Slack…');
  const result = await postToSlack(reportText, weekLabel);
  console.log('Posted. ts:', result.ts);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
