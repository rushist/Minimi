import { describe, expect, it, vi } from 'vitest';
import { createForecastData, forecastQuery } from './index.js';

const mumbai = {
  name: 'Mumbai',
  latitude: 19.07,
  longitude: 72.88,
  timezone: 'Asia/Kolkata',
  admin1: 'Maharashtra',
  country: 'India',
};
const forecast = {
  timezone: 'Asia/Kolkata',
  daily: {
    time: ['2026-11-15'],
    rain_sum: [1.4],
    showers_sum: [0.4],
    snowfall_sum: [0],
    precipitation_probability_max: [65],
    temperature_2m_min: [23],
    temperature_2m_max: [29],
  },
};

describe('daily forecast', () => {
  it('routes dated forecasts and leaves historical weather questions to research', () => {
    expect(
      forecastQuery(
        'Will it rain in Mumbai tomorrow? Give the forecast date, source, and probability if available.',
      ),
    ).toEqual({ location: 'Mumbai', date: 'tomorrow' });
    expect(forecastQuery('Weather forecast for Mumbai on 2026-11-15')).toEqual({
      location: 'Mumbai',
      date: '2026-11-15',
    });
    expect(
      forecastQuery('Did it rain in Mumbai in November 2025?'),
    ).toBeUndefined();
  });

  it('resolves tomorrow in the forecast location at a UTC day boundary', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ results: [mumbai] }))
      .mockResolvedValueOnce(Response.json(forecast));
    const weather = createForecastData(
      fetcher,
      () => new Date('2026-11-13T20:00:00Z'),
    );
    const result = await weather.forecast({
      location: 'Mumbai',
      date: 'tomorrow',
    });
    expect(result).toMatchObject({
      location: 'Mumbai, Maharashtra, India',
      timezone: 'Asia/Kolkata',
      date: '2026-11-15',
      rainMm: 1.8,
      precipitationProbability: 65,
      temperatureMinC: 23,
      temperatureMaxC: 29,
    });
    expect(new URL(result.sourceUrl).searchParams.get('start_date')).toBe(
      '2026-11-15',
    );
  });

  it('refuses to substitute the wrong day for a missing forecast', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ results: [mumbai] }))
      .mockResolvedValueOnce(Response.json(forecast));
    const weather = createForecastData(
      fetcher,
      () => new Date('2026-11-13T20:00:00Z'),
    );
    await expect(
      weather.forecast({ location: 'Mumbai', date: 'today' }),
    ).rejects.toMatchObject({ code: 'no_data' });
  });
});
