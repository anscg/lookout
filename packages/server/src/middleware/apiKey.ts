import type { FastifyRequest, FastifyReply } from "fastify";

const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY || "change-me";

export async function requireApiKey(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const key = request.headers["x-api-key"];
  if (key !== INTERNAL_API_KEY) {
    reply.code(401).send({ error: "Invalid API key" });
  }
}
