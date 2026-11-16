#!/usr/bin/env node
/**
 * Google Trends MCP server.
 *
 * Gives AI assistants (Claude, Cursor, VS Code, n8n agents...) live Google Trends data:
 * interest over time, interest by region and today's trending searches.
 * Data comes from the Apify Actor data_xplorer/google-trends-fast-scraper. Needs APIFY_TOKEN.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ApifyClient } from 'apify-client';
import { z } from 'zod';

const ACTOR = 'data_xplorer/google-trends-fast-scraper';
const TIMEFRAMES = ['now 1-h', 'now 4-h', 'now 1-d', 'now 7-d', 'today 1-m', 'today 3-m', 'today 12-m', 'today 5-y'];

async function runActor(input) {
    const token = process.env.APIFY_TOKEN;
    if (!token) throw new Error('APIFY_TOKEN is not set. Get one at https://console.apify.com/settings/integrations');
    const client = new ApifyClient({ token });
    const run = await client.actor(ACTOR).call(input, { log: null });
    if (run.status !== 'SUCCEEDED') throw new Error(`Apify run ${run.id} ended with status ${run.status}`);
    const { items } = await client.dataset(run.defaultDatasetId).listItems();
    return items;
}

const reply = (data) => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 1) }] });
const fail = (err) => ({ isError: true, content: [{ type: 'text', text: `Error: ${err.message}` }] });

const server = new McpServer({ name: 'google-trends', version: '1.0.1' });

server.registerTool('get_interest_over_time', {
    title: 'Google Trends: interest over time',
    description: 'Get Google Trends search interest (0-100) over time for one keyword, optionally with interest by region '
        + '(US states, regions of a country, or countries when worldwide). Use it to see if a topic is rising, '
        + 'find its peak, or compare seasons. Call once per keyword: each series is scaled 0-100 on its own peak.',
    inputSchema: {
        keyword: z.string().min(1).describe('One search term, e.g. "chatgpt" or "electric cars"'),
        geo: z.string().default('').describe('Country code like US, GB, FR, DE. Empty for worldwide'),
        timeframe: z.enum(TIMEFRAMES).default('today 12-m').describe('Period. Short periods give hourly points, long ones daily or weekly'),
        include_regions: z.boolean().default(false).describe('Also return interest by region (or by country when worldwide)'),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
}, async ({ keyword, geo, timeframe, include_regions }) => {
    try {
        const [item] = await runActor({
            mode: 'keyword', keyword, geo, predefinedTimeframe: timeframe, fetchRegionalData: include_regions,
        });
        if (!item) return reply({ keyword, message: 'No data returned' });
        if (item.error) {
            // e.g. not enough Google searches for this keyword, period and country
            return reply({ keyword, geo: geo || 'worldwide', timeframe, error: item.error });
        }
        const series = Object.entries(item.timeline_data?.[keyword] ?? {});
        const peak = series.reduce((a, b) => (b[1] > a[1] ? b : a), ['', -1]);
        return reply({
            keyword,
            geo: geo || 'worldwide',
            timeframe,
            granularity: item.data_granularity,
            peak: { date: peak[0], value: peak[1] },
            latest: series.at(-1) ? { date: series.at(-1)[0], value: series.at(-1)[1] } : null,
            series: Object.fromEntries(series),
            regions: include_regions ? (item.region_data ?? []).slice(0, 60) : undefined,
            google_trends_url: item.trends_url,
        });
    } catch (err) { return fail(err); }
});

server.registerTool('get_trending_searches', {
    title: 'Google Trends: trending searches',
    description: 'Get what people are searching for right now on Google in a country: the trending searches of the last '
        + '4, 24, 48 or 168 hours, with search volume and related queries. Use it for news, content ideas or market monitoring.',
    inputSchema: {
        country: z.string().default('US').describe('Country code, e.g. US, GB, FR, DE, IN, BR, JP (125 countries)'),
        hours: z.enum(['4', '24', '48', '168']).default('24').describe('Look-back window in hours'),
        max_results: z.number().int().min(1).max(100).default(25).describe('Number of trending searches to return'),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
}, async ({ country, hours, max_results }) => {
    try {
        const [item] = await runActor({
            mode: 'trending',
            trendingSearchesCountry: country,
            trendingSearchesTimeframe: hours,
            trendingSearchesMaxItems: max_results,
        });
        const searches = (item?.trending_searches ?? []).map((s) => ({
            rank: s.rank,
            term: s.term,
            volume: s.trend_volume,
            related: (s.related_terms ?? []).slice(0, 8),
        }));
        return reply({ country, hours: Number(hours), count: searches.length, trending_searches: searches });
    } catch (err) { return fail(err); }
});

await server.connect(new StdioServerTransport());
