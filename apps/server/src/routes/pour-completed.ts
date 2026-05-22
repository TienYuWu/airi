import type Redis from 'ioredis'

import type { HonoEnv } from '../types/hono'

import { useLogger } from '@guiiai/logg'
import { Hono } from 'hono'
import { object, optional, safeParse, string } from 'valibot'

import { createBadRequestError } from '../utils/error'

const logger = useLogger('pour-completed')

const POUR_COMPLETED_CHANNEL = 'robot:pour-completed'

/**
 * Inbound payload for `POST /api/robot/pour-completed`.
 *
 * Posted by main_task_node when an `ExecuteDrinkTask` action returns success
 * (excluding the `__go_home__` cleanup goal). Republished verbatim to the
 * `robot:pour-completed` Redis channel so the BT supervisor can drive the
 * post-pour follow-up branch.
 */
const PourCompletedSchema = object({
  drink_type: string(),
  table_id: optional(string()),
})

/**
 * Build the `/api/robot/pour-completed` Hono sub-app.
 *
 * Use when:
 * - Wiring routes in `app.ts`. Mount under `/api/robot/pour-completed`.
 *
 * Expects:
 * - `redis` is the primary connected client; reused for the publish.
 *
 * Returns:
 * - A Hono sub-app exposing `POST /`.
 */
export function createPourCompletedRoutes(redis: Redis) {
  return new Hono<HonoEnv>()
    .post('/', async (c) => {
      const raw = await c.req.json().catch(() => null)
      if (raw === null)
        throw createBadRequestError('Body must be JSON', 'INVALID_REQUEST')

      const parsed = safeParse(PourCompletedSchema, raw)
      if (!parsed.success)
        throw createBadRequestError('Invalid Request', 'INVALID_REQUEST', parsed.issues)

      const payload = JSON.stringify({
        drink_type: parsed.output.drink_type,
        table_id: parsed.output.table_id ?? '',
        at: new Date().toISOString(),
      })

      redis.publish(POUR_COMPLETED_CHANNEL, payload).catch((err) => {
        logger.withError(err as Error).warn('Failed to publish robot:pour-completed')
      })

      logger.withFields({ ...parsed.output }).log('Pour completed event published')

      return c.json({ success: true }, 201)
    })
}
