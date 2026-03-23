import type { OAuth2Namespace } from "@fastify/oauth2";
import type { AuthUser } from "./auth.js";

declare module "fastify" {
  interface FastifyRequest {
    user: AuthUser | null;
    rawBody?: string;
  }

  interface FastifyInstance {
    githubOAuth2?: OAuth2Namespace;
  }
}
