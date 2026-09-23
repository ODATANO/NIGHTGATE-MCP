import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { NightgateClient } from './client.js';
import { wrapHandler } from './tools.js';

/*
 * Analytics over the Midnight index, served by ODATANO ASTRA through the same
 * gateway and the same key (`/odata/v4/astra`, 1 unit per read). Every tool
 * pins `chain eq 'midnight'`; the Cardano server (@odatano/core-mcp) carries
 * the same tools for its chain, and `analytics_compare` puts both side by
 * side from either. Registered only when the gateway serves ASTRA.
 *
 * Ready-made first: overview, key figures, daily tables, the block-producer
 * ranking. The generic metric tools take one id of the catalogue
 * (`analytics_metrics` lists it): tx.count, tx.shielded, tx.withProof,
 * tx.contractCalls, fees.paid, fees.estimateError, blocks.interval, ...
 */

const CHAIN = 'midnight';

export const WINDOWS = ['1h', '24h', '7d', '14d', '30d'] as const;
export const RANKING_WINDOWS = ['24h', '7d', '14d', '30d'] as const;

/** Daily tables Midnight fills: tool argument -> entity set (no native tokens, no stake on this chain). */
export const DAILY_TOPICS = {
  blocks: 'BlocksDaily',
  transactions: 'TransactionsDaily',
  fees: 'FeesDaily',
} as const;

const METRIC_HINT = ' Metric ids come from analytics_metrics (e.g. tx.count, tx.shielded, tx.withProof, fees.paid, blocks.interval).';

/** `YYYY-MM-DD` of the UTC day `days - 1` days before today, so `days` covers today. */
export function sinceDay(days: number, now = Date.now()): string {
  const DAY = 86_400_000;
  return new Date(Math.floor(now / DAY) * DAY - (days - 1) * DAY).toISOString().slice(0, 10);
}

const rows = (payload: unknown): unknown => {
  const p = payload as Record<string, unknown> | null;
  return p && Array.isArray(p.value) ? p.value : payload;
};

const MAX_ROWS = 100;

export function registerAnalyticsTools(server: McpServer, client: NightgateClient): void {
  const run = wrapHandler(client);
  const chainFilter = `chain eq '${CHAIN}'`;

  server.registerTool(
    'analytics_overview',
    {
      description:
        'Midnight at a glance from ODATANO ASTRA: network, indexed tip and both lags (index behind chain, ' +
        'analytics behind index), blocks and transactions of the last hour with change vs the hour before, ' +
        'fees of the last 24 h in DUST (total, median, p95), average block time and transactions per block. ' +
        'While backfilling is true the recent windows are incomplete - read lastBlockAt.',
      inputSchema: {},
    },
    run(async () => rows(await client.analyticsQuery('ChainOverview', { filter: chainFilter }))),
  );

  server.registerTool(
    'analytics_key_figures',
    {
      description:
        'Every chain-wide Midnight metric over one rolling window (1h, 24h, 7d, 14d, 30d): value, the previous ' +
        'window and the change in percent, plus count/sum/avg/min/max/p50/p95 and the block range. Counters ' +
        'report the sum (blocks, regular transactions, shielded, with proof, contract calls/deploys, failed, ' +
        'system extrinsics), distributions the average (block interval, tx size, fee paid, fee estimate error). ' +
        'Narrow to one metric with `metric`.' + METRIC_HINT,
      inputSchema: {
        window: z.enum(WINDOWS).optional().describe('Rolling window (default 24h)'),
        metric: z.string().min(1).max(60).optional().describe('One metric id only, e.g. tx.shielded'),
      },
    },
    run(async (args) => {
      const parts = [chainFilter, `window eq '${args.window ?? '24h'}'`];
      if (args.metric) parts.push(`metric eq '${args.metric.replace(/'/g, "''")}'`);
      return rows(await client.analyticsQuery('KeyFigures', { filter: parts.join(' and '), orderby: 'metric' }));
    }),
  );

  server.registerTool(
    'analytics_daily',
    {
      description:
        'One row per UTC day for Midnight, newest first. topic blocks: blocks, empty blocks, avg/p95/max block ' +
        'time, tx per block. transactions: regular count, avg tx size, system extrinsics, shielded, with ZK ' +
        'proof, contract calls, contract deploys, failed. fees: total, fee-paying tx, avg/median/p95/max fee ' +
        'paid in DUST, total estimated fees, avg estimate error. Columns Midnight does not have are null.',
      inputSchema: {
        topic: z.enum(Object.keys(DAILY_TOPICS) as [keyof typeof DAILY_TOPICS, ...Array<keyof typeof DAILY_TOPICS>])
          .describe('Which daily table'),
        days: z.number().int().min(1).max(MAX_ROWS).optional().describe('How many days back including today (default 14)'),
      },
    },
    run(async (args) => {
      const days = args.days ?? 14;
      return rows(await client.analyticsQuery(DAILY_TOPICS[args.topic], {
        filter: `${chainFilter} and day ge ${sinceDay(days)}`,
        orderby: 'day desc',
        top: days,
      }));
    }),
  );

  server.registerTool(
    'analytics_top_block_producers',
    {
      description:
        'Midnight block authors ranked by blocks produced over a window (count; sum is the bytes produced), ' +
        'exact over the whole window. `entities` says how many distinct authors the window holds.',
      inputSchema: {
        window: z.enum(RANKING_WINDOWS).optional().describe('24h, 7d, 14d or 30d (default 24h)'),
        limit: z.number().int().min(1).max(MAX_ROWS).optional().describe('Rows (default 10)'),
      },
    },
    run(async (args) => rows(await client.analyticsQuery('TopBlockProducers', {
      filter: `${chainFilter} and window eq '${args.window ?? '24h'}' and rank le ${args.limit ?? 10}`,
      orderby: 'rank',
    }))),
  );

  server.registerTool(
    'analytics_metrics',
    {
      description:
        'The catalogue of Midnight metrics ASTRA computes: id, name, kind (counter / distribution), scope, ' +
        'unit and description. Use the ids with analytics_metric, analytics_series, analytics_compare and ' +
        'analytics_key_figures.',
      inputSchema: {},
    },
    run(async () => rows(await client.analyticsQuery('Metrics', {
      filter: chainFilter, select: 'ID,name,kind,scope,unit,description', orderby: 'ID', top: 200,
    }))),
  );

  server.registerTool(
    'analytics_metric',
    {
      description:
        'One Midnight metric over one rolling window with the previous window and the change in percent: ' +
        'value, count, sum, avg, min, max, p50, p95, stddev, block range.' + METRIC_HINT,
      inputSchema: {
        metric: z.string().min(1).max(60).describe('Metric id, e.g. tx.withProof'),
        window: z.enum(WINDOWS).optional().describe('Rolling window (default 24h)'),
      },
    },
    run(async (args) => client.analyticsFunction('getWindow', { chain: CHAIN, metric: args.metric, window: args.window ?? '24h' })),
  );

  server.registerTool(
    'analytics_series',
    {
      description:
        'Time series of one Midnight metric in the resolution of the window: 1h -> minutes, 24h -> hours, ' +
        '7d/14d/30d -> days. Each point: count, sum, avg, min, max, p50, p95, block range.' + METRIC_HINT,
      inputSchema: {
        metric: z.string().min(1).max(60).describe('Metric id, e.g. fees.paid'),
        window: z.enum(WINDOWS).optional().describe('Rolling window (default 24h)'),
      },
    },
    run(async (args) => client.analyticsFunction('getSeries', { chain: CHAIN, metric: args.metric, window: args.window ?? '24h' })),
  );

  server.registerTool(
    'analytics_compare',
    {
      description:
        'The same metric for Midnight and Cardano side by side over one window (only chains that have the ' +
        'metric answer): tx.count, blocks.count, blocks.interval, fees.paid, ... Fee units differ (DUST vs lovelace).' + METRIC_HINT,
      inputSchema: {
        metric: z.string().min(1).max(60).describe('Metric id both chains know, e.g. tx.count'),
        window: z.enum(WINDOWS).optional().describe('Rolling window (default 24h)'),
      },
    },
    run(async (args) => rows(await client.analyticsFunction('compare', { metric: args.metric, window: args.window ?? '24h' }))),
  );

  server.registerTool(
    'analytics_anomalies',
    {
      description:
        'Midnight days that sit far from their own recent baseline, in standard deviations, over the last ' +
        'COMPLETE day: metric, value, baseline, stddev, z, direction. Every number the verdict rests on comes back.',
      inputSchema: {
        threshold: z.number().min(1).max(20).optional().describe('z-score threshold (default 3)'),
        baselineDays: z.number().int().min(3).max(90).optional().describe('Days the baseline is built from (default 14)'),
      },
    },
    run(async (args) => client.analyticsFunction('getAnomalies', {
      chain: CHAIN, threshold: args.threshold ?? 3, baselineDays: args.baselineDays ?? 14,
    })),
  );
}
