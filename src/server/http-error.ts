export const GENERIC_SERVER_ERROR = "Something went wrong.";

export function genericServerErrorResponse(): Response {
  return new Response(JSON.stringify({ error: GENERIC_SERVER_ERROR }), {
    status: 500,
    headers: { "content-type": "application/json" },
  });
}
