import { Hono } from 'hono';
import type { AppEnv } from '../lib/authMiddleware';
import {
  acceptChangeRequest,
  createChangeRequest,
  declineChangeRequest,
  listChangeRequests,
  loadChangeRequest,
  voteOnChangeRequest,
  withdrawChangeRequest,
  type ChangeRequestInput,
} from '../lib/changeRequests';
import { loadEventIfVisible, loadOwnedActiveEvent } from './events';
import { assertOneOf, assertOptionalString, LIMITS, readJsonBody } from '../lib/validate';

export const changeRequestRoutes = new Hono<AppEnv>();

changeRequestRoutes.post('/:eventId/change-requests', async (c) => {
  const userId = c.get('userId');
  const eventId = c.req.param('eventId');
  const event = await loadEventIfVisible(c.env, eventId, userId);
  if (!event) return c.text('Not found', 404);

  const body = await readJsonBody<ChangeRequestInput>(c);
  const id = await createChangeRequest(c.env, event, userId, body);
  return c.json({ ok: true, id });
});

changeRequestRoutes.get('/:eventId/change-requests', async (c) => {
  const userId = c.get('userId');
  const eventId = c.req.param('eventId');
  const event = await loadEventIfVisible(c.env, eventId, userId);
  if (!event) return c.text('Not found', 404);

  const requests = await listChangeRequests(c.env, event, userId, event.organizer_id === userId);
  return c.json(requests);
});

changeRequestRoutes.post('/:eventId/change-requests/:id/vote', async (c) => {
  const userId = c.get('userId');
  const eventId = c.req.param('eventId');
  const requestId = c.req.param('id');
  const event = await loadEventIfVisible(c.env, eventId, userId);
  if (!event) return c.text('Not found', 404);

  const request = await loadChangeRequest(c.env, eventId, requestId);
  if (!request) return c.text('Not found', 404);

  const body = await readJsonBody<{ vote: 'yes' | 'no' | 'maybe' }>(c);
  const vote = assertOneOf(body.vote, 'vote', ['yes', 'no', 'maybe'] as const);
  await voteOnChangeRequest(c.env, event, request, userId, vote);
  return c.json({ ok: true });
});

changeRequestRoutes.post('/:eventId/change-requests/:id/accept', async (c) => {
  const userId = c.get('userId');
  const eventId = c.req.param('eventId');
  const requestId = c.req.param('id');
  const event = await loadOwnedActiveEvent(c.env, eventId, userId);
  if (!event) return c.text('Not found', 404);

  const request = await loadChangeRequest(c.env, eventId, requestId);
  if (!request) return c.text('Not found', 404);

  await acceptChangeRequest(c.env, event, request, userId);
  return c.json({ ok: true });
});

changeRequestRoutes.post('/:eventId/change-requests/:id/decline', async (c) => {
  const userId = c.get('userId');
  const eventId = c.req.param('eventId');
  const requestId = c.req.param('id');
  const event = await loadOwnedActiveEvent(c.env, eventId, userId);
  if (!event) return c.text('Not found', 404);

  const request = await loadChangeRequest(c.env, eventId, requestId);
  if (!request) return c.text('Not found', 404);

  const body = await readJsonBody<{ note?: string | null }>(c);
  const note = assertOptionalString(body.note, 'note', LIMITS.CHANGE_REQUEST_MESSAGE);
  await declineChangeRequest(c.env, request, userId, note);
  return c.json({ ok: true });
});

changeRequestRoutes.delete('/:eventId/change-requests/:id', async (c) => {
  const userId = c.get('userId');
  const eventId = c.req.param('eventId');
  const requestId = c.req.param('id');
  const event = await loadEventIfVisible(c.env, eventId, userId);
  if (!event) return c.text('Not found', 404);

  const request = await loadChangeRequest(c.env, eventId, requestId);
  if (!request) return c.text('Not found', 404);
  if (request.requester_id !== userId) return c.text('Forbidden', 403);

  await withdrawChangeRequest(c.env, request, userId);
  return c.json({ ok: true });
});
