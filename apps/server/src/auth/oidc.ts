import * as client from 'openid-client';
import type { Env } from '../env.ts';

export interface OidcChecks {
  verifier: string;
  state: string;
  nonce: string;
}

/** Sign-in with Google Workspace, Microsoft Entra ID or any OpenID Connect provider. */
export class Oidc {
  readonly label: string;
  #env: Env;
  #config: Promise<client.Configuration> | null = null;

  constructor(env: Env) {
    this.#env = env;
    this.label = env.OIDC_LABEL;
  }

  static fromEnv(env: Env): Oidc | null {
    return env.OIDC_ISSUER && env.OIDC_CLIENT_ID ? new Oidc(env) : null;
  }

  get issuer(): string {
    return this.#env.OIDC_ISSUER!;
  }

  #callbackUrl(): URL {
    return new URL('/auth/oidc/callback', this.#env.PUBLIC_URL);
  }

  #discover(): Promise<client.Configuration> {
    const issuer = new URL(this.issuer);
    // An http:// issuer is the admin's explicit choice (a Keycloak or Dex inside the network);
    // openid-client refuses it unless told to.
    const insecure = issuer.protocol === 'http:';
    this.#config ??= client
      .discovery(
        issuer,
        this.#env.OIDC_CLIENT_ID!,
        this.#env.OIDC_CLIENT_SECRET,
        undefined,
        insecure ? { execute: [client.allowInsecureRequests] } : undefined,
      )
      .catch((error: unknown) => {
        this.#config = null;
        throw error;
      });
    return this.#config;
  }

  async start(): Promise<{ url: string; checks: OidcChecks }> {
    const config = await this.#discover();
    const checks: OidcChecks = {
      verifier: client.randomPKCECodeVerifier(),
      state: client.randomState(),
      nonce: client.randomNonce(),
    };
    const url = client.buildAuthorizationUrl(config, {
      redirect_uri: this.#callbackUrl().toString(),
      scope: 'openid email profile',
      code_challenge: await client.calculatePKCECodeChallenge(checks.verifier),
      code_challenge_method: 'S256',
      state: checks.state,
      nonce: checks.nonce,
    });
    return { url: url.toString(), checks };
  }

  async finish(
    search: string,
    checks: OidcChecks,
  ): Promise<{ email: string; name: string | null }> {
    const config = await this.#discover();
    // Rebuild the callback URL from PUBLIC_URL so a reverse proxy does not break redirect_uri.
    const current = this.#callbackUrl();
    current.search = search;
    const tokens = await client.authorizationCodeGrant(config, current, {
      pkceCodeVerifier: checks.verifier,
      expectedState: checks.state,
      expectedNonce: checks.nonce,
    });
    const claims = tokens.claims();
    const email = (claims?.email ?? claims?.preferred_username) as string | undefined;
    if (!email || claims?.email_verified === false) {
      throw new Error('Your identity provider did not share a verified email address');
    }
    return { email: email.toLowerCase(), name: (claims?.name as string | undefined) ?? null };
  }
}
