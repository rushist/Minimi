import { z } from 'zod';

export interface ForecastQuery {
  location: string;
  date: string;
}

export function forecastQuery(message: string): ForecastQuery | undefined {
  const [firstSentence, ...rest] = message.split(/(?<=[?!])\s|\.(?=\s|$)/u);
  const details = rest
    .join(' ')
    .trim()
    .replace(/[.?!]+$/, '')
    .replace(/ if available$/i, '');
  if (
    details &&
    !/^(?:include|give|provide|state) (?:the )?(?:(?:forecast date|date|source|probability|timezone|time zone)(?:,?\s+(?:and\s+)?|$))+$/i.test(
      details,
    )
  )
    return;
  const match =
    /^(?:(?:will it (?:rain|snow)) (?:in|for)|(?:(?:what(?: is|['’]s) (?:the )?)?(?:weather(?: forecast)?|forecast) (?:in|for)))\s+(?<location>[\p{L}\p{M}0-9][\p{L}\p{M}0-9.,'’ -]{1,100}?)\s+(?:on\s+)?(?<date>today|tomorrow|\d{4}-\d{2}-\d{2})[?!]?$/iu.exec(
      firstSentence?.trim() ?? '',
    )?.groups;
  if (!match?.location || !match.date) return;
  const date = match.date.toLowerCase();
  if (
    date !== 'today' &&
    date !== 'tomorrow' &&
    !z.iso.date().safeParse(date).success
  )
    return;
  return { location: match.location.trim(), date };
}

const forecastErrors = {
  location:
    'The forecast service could not find that location. Include the region or country.',
  date: 'The requested date is outside the available forecast window.',
  no_data:
    'The forecast service did not provide a forecast for that location and date.',
  rate_limit:
    'The forecast provider is rate limiting requests. Try again after its limit resets.',
  timeout: 'The forecast request timed out. Try again.',
  unavailable: 'The forecast service is unavailable.',
} as const;

export class ForecastDataError extends Error {
  constructor(readonly code: keyof typeof forecastErrors) {
    super(forecastErrors[code]);
  }
}

export function forecastErrorMessage(error: unknown) {
  return error instanceof ForecastDataError
    ? error.message
    : forecastErrors.unavailable;
}

const locationSchema = z.object({
  name: z.string().min(1),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  timezone: z.string().min(1),
  admin1: z.string().optional(),
  country: z.string().optional(),
});
const geocodingResponse = z.object({
  results: z.array(locationSchema).optional(),
});
const forecastResponse = z.object({
  timezone: z.string().min(1),
  daily: z.object({
    time: z.array(z.iso.date()),
    rain_sum: z.array(z.number().nonnegative().nullable()),
    showers_sum: z.array(z.number().nonnegative().nullable()),
    snowfall_sum: z.array(z.number().nonnegative().nullable()),
    precipitation_probability_max: z.array(
      z.number().min(0).max(100).nullable(),
    ),
    temperature_2m_min: z.array(z.number().nullable()),
    temperature_2m_max: z.array(z.number().nullable()),
  }),
});

function dateAt(now: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat('en', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  return ['year', 'month', 'day']
    .map((type) => parts.find((part) => part.type === type)?.value)
    .join('-');
}

function addDays(date: string, days: number) {
  return new Date(Date.parse(date) + days * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

export function createForecastData(fetcher = fetch, now = () => new Date()) {
  async function json(url: URL, parent?: AbortSignal) {
    const deadline = AbortSignal.timeout(3500);
    const signal = parent ? AbortSignal.any([parent, deadline]) : deadline;
    try {
      const response = await fetcher(url, { redirect: 'error', signal });
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw new ForecastDataError(
          response.status === 429 ? 'rate_limit' : 'unavailable',
        );
      }
      return (await response.json()) as unknown;
    } catch (error) {
      if (deadline.aborted) throw new ForecastDataError('timeout');
      throw error;
    }
  }

  return {
    async forecast(query: ForecastQuery, signal?: AbortSignal) {
      const geocodingUrl = new URL(
        'https://geocoding-api.open-meteo.com/v1/search',
      );
      geocodingUrl.search = new URLSearchParams({
        name: query.location,
        count: '1',
      }).toString();
      const match = geocodingResponse.safeParse(
        await json(geocodingUrl, signal),
      );
      if (!match.success) throw new ForecastDataError('unavailable');
      const location = match.data.results?.[0];
      if (!location) throw new ForecastDataError('location');

      const today = dateAt(now(), location.timezone);
      const date =
        query.date === 'today'
          ? today
          : query.date === 'tomorrow'
            ? addDays(today, 1)
            : query.date;
      if (
        !z.iso.date().safeParse(date).success ||
        date < today ||
        date > addDays(today, 15)
      )
        throw new ForecastDataError('date');
      const url = new URL('https://api.open-meteo.com/v1/forecast');
      url.search = new URLSearchParams({
        latitude: String(location.latitude),
        longitude: String(location.longitude),
        start_date: date,
        end_date: date,
        timezone: location.timezone,
        daily:
          'rain_sum,showers_sum,snowfall_sum,precipitation_probability_max,temperature_2m_min,temperature_2m_max',
      }).toString();
      const result = forecastResponse.safeParse(await json(url, signal));
      if (!result.success) throw new ForecastDataError('no_data');
      const { daily, timezone } = result.data;
      const index = daily.time.indexOf(date);
      const rain = daily.rain_sum[index];
      const showers = daily.showers_sum[index];
      const snowfallCm = daily.snowfall_sum[index];
      const temperatureMinC = daily.temperature_2m_min[index];
      const temperatureMaxC = daily.temperature_2m_max[index];
      if (
        rain == null ||
        showers == null ||
        snowfallCm == null ||
        temperatureMinC == null ||
        temperatureMaxC == null
      )
        throw new ForecastDataError('no_data');
      return {
        location: [
          ...new Set(
            [location.name, location.admin1, location.country].filter(Boolean),
          ),
        ].join(', '),
        date,
        timezone,
        rainMm: Math.round((rain + showers) * 10) / 10,
        snowfallCm,
        precipitationProbability:
          daily.precipitation_probability_max[index] ?? null,
        temperatureMinC,
        temperatureMaxC,
        sourceUrl: url.href,
      };
    },
  };
}

export type ForecastData = ReturnType<typeof createForecastData>;
