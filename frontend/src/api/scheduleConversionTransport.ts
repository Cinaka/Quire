import {
  conversionFailure, ConversionTransportError, parseConversionRejection, parseConversionSourceFailure,
} from "@/shared/scheduleConversionSync"
import type { ConversionFailure, ConversionTransport } from "@/shared/scheduleConversionSync"
import { scheduleEntryId } from "@/shared/schedules"

import { ApiError, postPinnedSchedule } from "./request"

function validSourceId(value: unknown): value is string {
  try { return typeof value === "string" && scheduleEntryId(value) === value }
  catch { return false }
}
function safeFailure(stage: ConversionFailure["stage"], error: unknown, id: string): ConversionTransportError {
  if (error instanceof ConversionTransportError) return error
  if (error instanceof ApiError) {
    if (stage === "convert" && error.status === 409 && error.code === 409) {
      try { return new ConversionTransportError(parseConversionRejection(error.data, id)) }
      catch { return new ConversionTransportError(conversionFailure(stage, "invalid_response")) }
    }
    const reason = error.status === 401 ? "unauthorized" : error.status === 404 ? "not_found" :
      error.status === 422 ? "invalid_request" : error.status && error.status >= 500 ? "storage" : "network"
    return new ConversionTransportError(conversionFailure(stage, reason))
  }
  return new ConversionTransportError(conversionFailure(stage, "network"))
}
/** Real protocol adapter, but factory creation does not send or enable anything. */
export function createScheduleConversionTransport(): ConversionTransport {
  return {
    async pushSource(body, lease) {
      const request = body as { schedules?: Array<{ id?: unknown }> } | null
      const id = request?.schedules?.[0]?.id
      if (!validSourceId(id) || request?.schedules?.length !== 1) {
        throw new ConversionTransportError(conversionFailure("source", "invalid_request"))
      }
      let raw: unknown
      try { raw = await postPinnedSchedule("/schedules/sync/push", body, lease) }
      catch (error) { throw safeFailure("source", error, id) }
      try {
        const failure = parseConversionSourceFailure(raw, id)
        if (failure) throw new ConversionTransportError(failure)
      } catch (error) {
        if (error instanceof ConversionTransportError) throw error
        throw new ConversionTransportError(conversionFailure("source", "invalid_response"))
      }
      return raw
    },
    async convert(id, body, lease) {
      if (!validSourceId(id)) throw new ConversionTransportError(conversionFailure("convert", "invalid_request"))
      try { return await postPinnedSchedule(`/schedules/${id}/convert`, body, lease) }
      catch (error) { throw safeFailure("convert", error, id) }
    },
  }
}
