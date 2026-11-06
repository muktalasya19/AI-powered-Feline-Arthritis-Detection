import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";

// Firebase ID tokens are signed by Google's securetoken service.
const JWKS = createRemoteJWKSet(
  new URL("https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com"),
);

export interface FirebaseUser extends JWTPayload {
  uid: string;
  email?: string;
  orgs?: Record<string, string>;
  isVet?: boolean;
}

/** Verify a Firebase ID token from an `Authorization: Bearer <token>` header. */
export async function verifyFirebaseToken(header: string | undefined, projectId: string): Promise<FirebaseUser> {
  if (!header?.startsWith("Bearer ")) throw new Error("missing bearer token");
  const token = header.slice(7);
  const { payload } = await jwtVerify(token, JWKS, {
    issuer: `https://securetoken.google.com/${projectId}`,
    audience: projectId,
  });
  if (!payload.sub) throw new Error("token has no subject");
  return { ...payload, uid: payload.sub } as FirebaseUser;
}
