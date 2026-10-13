import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from "aws-lambda";

export type ApiEvent = APIGatewayProxyEventV2WithJWTAuthorizer;

export function json(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
    body: JSON.stringify(body),
  };
}

/** The caller's Cognito sub, verified by the API Gateway JWT authorizer. */
export function userIdOf(event: ApiEvent): string {
  const sub = event.requestContext.authorizer.jwt.claims.sub;
  if (typeof sub !== "string" || !/^[0-9a-f-]{36}$/.test(sub)) {
    throw new Error("Missing or malformed sub claim");
  }
  return sub;
}

export function parseBody(event: ApiEvent): any | undefined {
  if (!event.body) return {};
  try {
    const raw = event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable ${name}`);
  return value;
}
