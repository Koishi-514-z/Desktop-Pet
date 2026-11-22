import type { Skill } from '@/agent/types'
import { tool } from 'ai'
import { z } from 'zod'
import { get } from '@/utils/web'

// 使用 Open-Meteo 的免费接口，无需 API Key：https://open-meteo.com/
const GEOCODING_URL = 'https://geocoding-api.open-meteo.com/v1/search'
const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast'

// WMO 天气代码
const WEATHER_CODES: Record<number, string> = {
  0: '晴',
  1: '晴间少云',
  2: '多云',
  3: '阴',
  45: '雾',
  48: '冻雾',
  51: '小毛毛雨',
  53: '毛毛雨',
  55: '大毛毛雨',
  56: '冻毛毛雨',
  57: '强冻毛毛雨',
  61: '小雨',
  63: '中雨',
  65: '大雨',
  66: '冻雨',
  67: '强冻雨',
  71: '小雪',
  73: '中雪',
  75: '大雪',
  77: '雪粒',
  80: '小阵雨',
  81: '阵雨',
  82: '强阵雨',
  85: '阵雪',
  86: '强阵雪',
  95: '雷阵雨',
  96: '雷阵雨伴小冰雹',
  99: '雷阵雨伴大冰雹',
}

function describeWeather(code: number): string {
  return WEATHER_CODES[code] ?? `未知（代码 ${code}）`
}

interface GeocodingResponse {
  results?: { name: string, latitude: number, longitude: number, country?: string, admin1?: string, timezone?: string }[]
}

interface ForecastResponse {
  current: {
    time: string
    temperature_2m: number
    apparent_temperature: number
    relative_humidity_2m: number
    weather_code: number
    wind_speed_10m: number
  }
  daily: {
    time: string[]
    weather_code: number[]
    temperature_2m_max: number[]
    temperature_2m_min: number[]
    precipitation_probability_max: (number | null)[]
  }
}

export const weatherSkill: Skill = {
  id: 'weather',
  name: '天气',
  description: '查询指定城市的实时天气和未来几天的天气预报（气温、天气状况、降水概率等）。',
  examples: ['北京今天天气怎么样', '明天上海会下雨吗', '这周末冷不冷'],
  instructions: `- 调用 get_weather 查询天气，city 填写城市名（如 北京、Tokyo）；如果提示找不到城市，换用英文名或拼音重试一次。
- 用户没说城市时，先从对话上下文中推断；仍然无法确定就不要调用工具，说明需要用户告诉你是哪个城市。
- 只问今天的天气时 days 填 1，问明天填 2，问这周或周末时根据日期填写足够的天数（最多 7 天）。`,
  tools: {
    get_weather: tool({
      description: '查询城市的实时天气与每日天气预报',
      inputSchema: z.object({
        city: z.string().min(2).describe('城市名，如 北京、Tokyo'),
        days: z.number().int().min(1).max(7).default(3).describe('预报天数（含今天），1~7'),
      }),
      execute: async ({ city, days }) => {
        const geo = await get<GeocodingResponse>(GEOCODING_URL, {
          params: { name: city, count: 1, language: 'zh', format: 'json' },
        })
        const place = geo.results?.[0]
        if (!place) throw new Error(`没有找到城市「${city}」，请换用英文名或拼音重试`)

        const forecast = await get<ForecastResponse>(FORECAST_URL, {
          params: {
            latitude: place.latitude,
            longitude: place.longitude,
            current: 'temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m',
            daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max',
            timezone: 'auto',
            forecast_days: days,
          },
        })

        const { current, daily } = forecast
        return {
          location: [place.name, place.admin1, place.country].filter(Boolean).join('，'),
          current: {
            time: current.time,
            weather: describeWeather(current.weather_code),
            temperature: `${current.temperature_2m}°C`,
            feelsLike: `${current.apparent_temperature}°C`,
            humidity: `${current.relative_humidity_2m}%`,
            windSpeed: `${current.wind_speed_10m} km/h`,
          },
          daily: daily.time.map((date, i) => ({
            date,
            weather: describeWeather(daily.weather_code[i]!),
            temperature: `${daily.temperature_2m_min[i]}~${daily.temperature_2m_max[i]}°C`,
            precipitationProbability: daily.precipitation_probability_max[i] == null ? '未知' : `${daily.precipitation_probability_max[i]}%`,
          })),
        }
      },
    }),
  },
}
