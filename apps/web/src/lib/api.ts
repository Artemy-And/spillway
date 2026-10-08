import type { ApiType } from '@server/app.ts';
import { queryOptions } from '@tanstack/react-query';
import { type ClientResponse, hc, type InferResponseType } from 'hono/client';

const client = hc<ApiType>('/');

export const api = client.admin.api;
export const auth = client.auth;

export class ApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

type Ok<R> =
  R extends ClientResponse<infer T, infer S, 'json'> ? (S extends 200 | 201 ? T : never) : never;

/** Resolves to the success body, or throws ApiError with the server's message. */
export async function unwrap<R extends ClientResponse<unknown, number, 'json'>>(
  request: Promise<R>,
): Promise<Ok<R>> {
  const res = await request;
  const body = (await res.json().catch(() => null)) as {
    error?: string | { issues?: { message: string }[] };
  } | null;
  if (!res.ok) {
    const error = body?.error;
    const message =
      typeof error === 'string'
        ? error
        : (error?.issues?.[0]?.message ?? `Request failed (${res.status})`);
    throw new ApiError(message, res.status);
  }
  return body as Ok<R>;
}

export const meQuery = queryOptions({
  queryKey: ['me'],
  queryFn: () => unwrap(api.me.$get()),
  staleTime: 60_000,
});

export const modelsQuery = queryOptions({
  queryKey: ['models'],
  queryFn: () => unwrap(api.models.$get()),
});

export const teamsQuery = queryOptions({
  queryKey: ['teams'],
  queryFn: () => unwrap(api.teams.$get()),
});

export type Me = InferResponseType<typeof api.me.$get, 200>;
export type ModelRow = InferResponseType<typeof api.models.$get, 200>[number];
export type TeamRow = InferResponseType<typeof api.teams.$get, 200>[number];
export type KeyRow = InferResponseType<typeof api.keys.$get, 200>[number];
export type Overview = InferResponseType<typeof api.overview.$get, 200>;
export type LogRow = InferResponseType<typeof api.logs.$get, 200>[number];
export type LogDetail = InferResponseType<(typeof api.logs)[':id']['$get'], 200>;
export type UserRow = InferResponseType<typeof api.users.$get, 200>[number];
export type ProviderRow = InferResponseType<typeof api.providers.$get, 200>[number];
export type ComparisonReport = InferResponseType<(typeof api.comparisons)[':id']['$get'], 200>;
export type RoutingProfileRow = InferResponseType<
  (typeof api)['routing-profiles']['$get'],
  200
>[number];
export type Rules = InferResponseType<typeof api.rules.$get, 200>;
