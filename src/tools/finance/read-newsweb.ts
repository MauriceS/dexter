import { DynamicStructuredTool } from '@langchain/core/tools';
import type { RunnableConfig } from '@langchain/core/runnables';
import { z } from 'zod';
import { callLlm } from '../../model/llm.js';
import { formatToolResult } from '../types.js';
import { getCurrentDate } from '../../agent/prompts.js';
import {
  NEWSWEB_CATEGORY,
  resolveOsloIssuer,
  listNewswobFilings,
  getNewswobMessage,
  newswobMessageUrl,
  type NewswobMessage,
} from './newsweb-api.js';

/**
 * Rich description used in the system prompt to guide the LLM on when and
 * how to invoke the read_oslo_filings tool.
 */
export const READ_OSLO_FILINGS_DESCRIPTION = `
Intelligent meta-tool for reading Oslo Stock Exchange (Oslo Børs) company announcements and filings from Newsweb. Takes a natural language query and fetches full announcement text for the requested ticker.

## When to Use

- Reading annual reports for Norwegian/Oslo-listed companies (e.g. VEI.OL, EQNR.OL, DNB.OL)
- Reading quarterly or half-yearly financial reports from Oslo Børs companies
- Researching insider trades or major shareholding notifications for Oslo-listed stocks
- Finding press releases, capital increase announcements, or regulatory filings from Oslo Børs
- Any query about filings or announcements for a company with a .OL ticker

## When NOT to Use

- US companies or tickers without the .OL suffix (use read_filings for SEC filings)
- Real-time stock prices (use financial_search or web_search)
- Structured financial metrics like revenue/EPS figures (use financial_metrics)
- Generic news (use web_search)

## Usage Notes

- Call ONCE with the full natural language query
- Accepts Oslo Børs tickers (VEI.OL), company names (Veidekke), or bare ticker signs (VEI)
- Maps query intent to appropriate announcement categories (annual report → category 1001, quarterly → 1002, insider trades → 1102, etc.)
- Retrieves up to 3 full announcement bodies per query
`.trim();

// ---- Planning schema --------------------------------------------------------

const OsloPlanSchema = z.object({
  issuerSign: z
    .string()
    .describe(
      'The Oslo Børs ticker sign without the exchange suffix. E.g. "VEI" from "VEI.OL" or "Veidekke". Must be uppercase.'
    ),
  categories: z
    .array(z.number().int())
    .min(1)
    .describe(
      'List of Newsweb category IDs relevant to the query. ' +
        '1001=Annual reports, 1002=Quarterly/Half-yearly, 1004=Capital increases, ' +
        '1006=Major shareholding notifications, 1010=Additional regulated info, ' +
        '1101=Ex-date, 1102=Insider trades, 1104=Press releases'
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(10)
    .describe('Maximum number of announcements to fetch per category (default 5)'),
  fromDate: z
    .string()
    .optional()
    .describe('Optional ISO8601 date to filter results from (e.g. "2024-01-01")'),
  toDate: z
    .string()
    .optional()
    .describe('Optional ISO8601 date to filter results to (e.g. "2024-12-31")'),
});

type OsloPlan = z.infer<typeof OsloPlanSchema>;

// ---- Prompt helpers ---------------------------------------------------------

function buildPlanPrompt(): string {
  return `You are a planning assistant for Oslo Børs (Oslo Stock Exchange) filings.
Current date: ${getCurrentDate()}

Given a user query about Oslo Børs announcements or filings, return structured fields:
- issuerSign (ticker without .OL suffix, UPPERCASE)
- categories (Newsweb category IDs)
- limit (default 5)
- fromDate / toDate (optional, ISO8601 date strings if the query implies a specific period)

## Ticker Resolution Examples

- "Veidekke" or "VEI.OL" → issuerSign: "VEI"
- "Equinor" or "EQNR.OL" → issuerSign: "EQNR"
- "DNB" or "DNB.OL" → issuerSign: "DNB"
- "Aker BP" or "AKRBP.OL" → issuerSign: "AKRBP"
- "Telenor" or "TEL.OL" → issuerSign: "TEL"
- "Yara" or "YAR.OL" → issuerSign: "YAR"
- "Mowi" or "MOWI.OL" → issuerSign: "MOWI"
- "Orkla" or "ORK.OL" → issuerSign: "ORK"
- "Storebrand" or "STB.OL" → issuerSign: "STB"

## Category Mapping

- "annual report", "årsrapport", "10-K equivalent" → 1001
- "quarterly", "Q1/Q2/Q3/Q4 results", "half-year", "interim" → 1002
- "capital increase", "rights issue", "share issue" → 1004
- "major shareholding", "flagging", "> 5% stake" → 1006
- "AGM", "financial calendar", "regulated info" → 1010
- "ex-date", "ex-dividend" → 1101
- "insider trade", "primary insider", "mandatory notification of trade" → 1102
- "press release", "news", "announcement" (non-regulatory) → 1104
- Broad queries about a company's filings → include [1001, 1002]

Return only the structured output fields, no prose.`;
}

// ---- Input schema -----------------------------------------------------------

const ReadOsloFilingsInputSchema = z.object({
  query: z
    .string()
    .describe(
      'Natural language query about Oslo Børs announcements or filings to read, including the company/ticker and the type of information needed'
    ),
});

// ---- Tool factory -----------------------------------------------------------

/**
 * Creates a read_oslo_filings tool configured with the specified model.
 * Uses a single structured-output planning call to extract parameters,
 * then directly fetches announcement data from the Newsweb API.
 */
export function createReadOsloFilings(model: string): DynamicStructuredTool {
  return new DynamicStructuredTool({
    name: 'read_oslo_filings',
    description: `Reads Oslo Stock Exchange (Oslo Børs) company announcements and filings from Newsweb. Use for:
- Annual reports, quarterly results for Norwegian/Oslo Børs companies (tickers ending in .OL)
- Insider trade notifications, major shareholding changes
- Press releases and regulatory filings from Oslo-listed companies`,
    schema: ReadOsloFilingsInputSchema,
    func: async (input, _runManager, config?: RunnableConfig) => {
      const onProgress = config?.metadata?.onProgress as ((msg: string) => void) | undefined;

      // Step 1: Extract structured plan from natural language query
      onProgress?.('Planning Oslo Børs filing search...');
      let plan: OsloPlan;
      try {
        const { response: planResponse } = await callLlm(input.query, {
          model,
          systemPrompt: buildPlanPrompt(),
          outputSchema: OsloPlanSchema,
        });
        plan = OsloPlanSchema.parse(planResponse);
      } catch (error) {
        return formatToolResult(
          {
            error: 'Failed to plan Oslo filing search',
            details: error instanceof Error ? error.message : String(error),
          },
          []
        );
      }

      // Step 2: Resolve ticker to issuerId
      onProgress?.(`Resolving Oslo Børs issuer for ${plan.issuerSign}...`);
      const issuer = await resolveOsloIssuer(plan.issuerSign);
      if (!issuer) {
        return formatToolResult(
          {
            error: `Issuer not found on Oslo Børs: ${plan.issuerSign}`,
            hint: 'Check the ticker sign (e.g. "VEI" for Veidekke, "EQNR" for Equinor)',
          },
          []
        );
      }

      const { issuerId, name: issuerName } = issuer;

      // Step 3: Fetch listing for each requested category in parallel
      onProgress?.(
        `Fetching filings for ${issuerName ?? plan.issuerSign} (categories: ${plan.categories.join(', ')})...`
      );

      const listOptions = {
        fromDate: plan.fromDate,
        toDate: plan.toDate,
      };

      let messages: NewswobMessage[] = [];
      try {
        const listResults = await Promise.all(
          plan.categories.map((cat) =>
            listNewswobFilings(issuerId!, { ...listOptions, category: cat })
          )
        );
        // Merge, de-duplicate by messageId, sort newest first
        const seen = new Set<number>();
        for (const batch of listResults) {
          for (const msg of batch) {
            if (!seen.has(msg.messageId)) {
              seen.add(msg.messageId);
              messages.push(msg);
            }
          }
        }
        messages.sort(
          (a, b) =>
            new Date(b.publishedTime).getTime() - new Date(a.publishedTime).getTime()
        );
        messages = messages.slice(0, plan.limit);
      } catch (error) {
        return formatToolResult(
          {
            error: 'Failed to list Oslo Børs filings',
            details: error instanceof Error ? error.message : String(error),
            issuerSign: plan.issuerSign,
            issuerId,
          },
          []
        );
      }

      if (messages.length === 0) {
        return formatToolResult(
          {
            error: 'No announcements found',
            issuerSign: plan.issuerSign,
            issuerName,
            categories: plan.categories,
            fromDate: plan.fromDate,
            toDate: plan.toDate,
          },
          []
        );
      }

      // Step 4: Fetch full message detail for the top 3 results
      const toRead = messages.slice(0, 3);
      const remaining = messages.slice(3);

      onProgress?.(
        `Reading ${toRead.length} announcement${toRead.length !== 1 ? 's' : ''} for ${issuerName ?? plan.issuerSign}...`
      );

      const detailResults = await Promise.allSettled(
        toRead.map((msg) => getNewswobMessage(msg.messageId))
      );

      const announcements: unknown[] = [];
      const sourceUrls: string[] = [];

      for (const [index, result] of detailResults.entries()) {
        const summary = toRead[index];
        const url = newswobMessageUrl(summary.messageId);

        if (result.status === 'fulfilled') {
          const detail = result.value;
          const categoryLabel =
            detail.category?.[0]?.category_en ?? String(plan.categories[0]);

          announcements.push({
            messageId: detail.messageId,
            title: detail.title,
            publishedTime: detail.publishedTime,
            category: categoryLabel,
            issuer: issuerName ?? plan.issuerSign,
            body: detail.body,
            attachments: detail.attachments?.map((a) => ({
              name: a.name,
              downloadUrl: `https://api3.oslo.oslobors.no/v1/newsreader/attachment?messageId=${detail.messageId}&attachmentId=${a.id}`,
            })),
            url,
          });
          sourceUrls.push(url);
        } else {
          announcements.push({
            messageId: summary.messageId,
            title: summary.title,
            publishedTime: summary.publishedTime,
            error: 'Failed to fetch full message body',
            url,
          });
        }
      }

      // Include a summary list of remaining (not fully fetched) messages
      const additionalSummaries =
        remaining.length > 0
          ? remaining.map((msg) => ({
              messageId: msg.messageId,
              title: msg.title,
              publishedTime: msg.publishedTime,
              category: msg.category?.[0]?.category_en,
              url: newswobMessageUrl(msg.messageId),
            }))
          : undefined;

      return formatToolResult(
        {
          issuer: issuerName ?? plan.issuerSign,
          issuerSign: plan.issuerSign,
          query: input.query,
          announcements,
          ...(additionalSummaries && { additionalResults: additionalSummaries }),
        },
        sourceUrls
      );
    },
  });
}
