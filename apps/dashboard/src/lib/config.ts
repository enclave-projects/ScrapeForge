/** Inlined at build time from the deployed stacks' outputs. */
export const config = {
  apiBaseUrl: process.env.NEXT_PUBLIC_API_BASE_URL ?? "",
  userPoolId: process.env.NEXT_PUBLIC_USER_POOL_ID ?? "",
  userPoolClientId: process.env.NEXT_PUBLIC_USER_POOL_CLIENT_ID ?? "",
}
