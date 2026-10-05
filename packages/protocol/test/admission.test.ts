import { describe, expect, it } from 'vitest'
import {
  admissionProtocols,
  deriveAdmissionToken,
  readAdmissionProtocol,
} from '../src/admission.ts'
import { deriveBlobKeys } from '../src/blob.ts'

describe('room admission', () => {
  it('matches the independently computed Go test vector and separates the capability from the key', async () => {
    const key = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8'
    const token = await deriveAdmissionToken(key)
    expect(token).toBe('yLmGLPEIKTlJRTyTeaGzls7vTRq2eymHCb_TJWm55EI')
    expect(token).not.toBe(key)
    expect((await deriveBlobKeys(key)).admission).toBe(token)
    expect(readAdmissionProtocol(admissionProtocols(token).join(', '))).toBe(token)
    await expect(deriveAdmissionToken('bad')).rejects.toThrow()
  })

  it('rejects missing, malformed and ambiguous subprotocol credentials', () => {
    const token = 'A'.repeat(43)
    for (const value of [
      null,
      '',
      'pedit-v1',
      `pedit-admission.${token}`,
      'pedit-v1, pedit-admission.bad',
      `pedit-v1, pedit-admission.${token}, pedit-admission.${token}`,
    ]) {
      expect(readAdmissionProtocol(value)).toBeNull()
    }
    expect(() => admissionProtocols('bad')).toThrow()
  })
})
