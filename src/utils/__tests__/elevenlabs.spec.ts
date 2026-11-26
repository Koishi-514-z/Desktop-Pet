import { beforeEach, describe, expect, it, vi } from 'vitest'

const httpFetch = vi.hoisted(() => vi.fn<(input: string, init?: RequestInit) => Promise<Response>>())
vi.mock('@/utils/http', () => ({ httpFetch }))

import { deleteElevenLabsVoice, listElevenLabsVoices, toProviderVoice } from '@/utils/elevenlabs'

const provider = { apiKey: 'sk-test' }
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const headersOf = (init?: RequestInit) => init?.headers as Record<string, string>

beforeEach(() => {
  httpFetch.mockReset()
})

describe('ElevenLabs 声线', () => {
  it('官方预置的声线不能删；自己创建的、从 Voice Library 加入的标注出来，可以删除', () => {
    expect(toProviderVoice({ voice_id: 'roger', name: 'Roger', category: 'premade', is_owner: false })).toEqual({ id: 'roger', name: 'Roger' })
    expect(toProviderVoice({ voice_id: 'mine', name: '我的克隆', category: 'cloned', is_owner: true }))
      .toEqual({ id: 'mine', name: '我的克隆', description: '我的音色 · 自己创建', deletable: true })
    expect(toProviderVoice({ voice_id: 'aki', name: 'Aki', category: 'professional', is_owner: false }))
      .toEqual({ id: 'aki', name: 'Aki', description: '我的音色 · 来自 Voice Library', deletable: true })
  })

  it('查询声线：带上 API Key，跳过没有 ID 的条目', async () => {
    httpFetch.mockResolvedValueOnce(json({
      voices: [
        { voice_id: 'roger', name: 'Roger', category: 'premade', is_owner: false },
        { voice_id: 'aki', name: 'Aki', category: 'professional', is_owner: false },
        { name: '坏数据' },
      ],
    }))
    const voices = await listElevenLabsVoices(provider)

    expect(httpFetch.mock.calls[0]![0]).toBe('https://api.elevenlabs.io/v1/voices')
    expect(headersOf(httpFetch.mock.calls[0]![1])['xi-api-key']).toBe('sk-test')
    expect(voices.map((voice) => [voice.id, !!voice.deletable])).toEqual([['roger', false], ['aki', true]])
  })

  it('删除音色：DELETE /v1/voices/{id}', async () => {
    httpFetch.mockResolvedValueOnce(json({ status: 'ok' }))
    await deleteElevenLabsVoice(provider, 'voice/1')

    const [url, init] = httpFetch.mock.calls[0]!
    expect(url).toBe('https://api.elevenlabs.io/v1/voices/voice%2F1')
    expect(init?.method).toBe('DELETE')
    expect(headersOf(init)['xi-api-key']).toBe('sk-test')
  })

  it('删除失败时给出接口返回的原因', async () => {
    httpFetch.mockResolvedValueOnce(json({ detail: { status: 'voice_not_found', message: 'A voice with the voice_id aki was not found.' } }, 404))
    await expect(deleteElevenLabsVoice(provider, 'aki')).rejects.toThrow('ElevenLabs 接口出错（HTTP 404）：A voice with the voice_id aki was not found.')

    httpFetch.mockResolvedValueOnce(json({ detail: [{ loc: ['path', 'voice_id'], msg: 'field required', type: 'missing' }] }, 422))
    await expect(deleteElevenLabsVoice(provider, '')).rejects.toThrow('field required')

    httpFetch.mockResolvedValueOnce(json({ detail: { status: 'invalid_api_key', message: 'Invalid API key' } }, 401))
    await expect(deleteElevenLabsVoice(provider, 'aki')).rejects.toThrow('API Key 无效')
  })
})
