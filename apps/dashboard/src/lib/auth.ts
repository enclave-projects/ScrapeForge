import {
  AuthenticationDetails,
  CognitoUser,
  CognitoUserAttribute,
  CognitoUserPool,
  type CognitoUserSession,
} from "amazon-cognito-identity-js"
import { config } from "./config"

let pool: CognitoUserPool | undefined

function getPool(): CognitoUserPool {
  pool ??= new CognitoUserPool({
    UserPoolId: config.userPoolId,
    ClientId: config.userPoolClientId,
  })
  return pool
}

function userFor(email: string): CognitoUser {
  return new CognitoUser({ Username: email, Pool: getPool() })
}

export function signUp(email: string, password: string): Promise<void> {
  return new Promise((resolve, reject) => {
    getPool().signUp(
      email,
      password,
      [new CognitoUserAttribute({ Name: "email", Value: email })],
      [],
      (err) => (err ? reject(err) : resolve())
    )
  })
}

export function confirmSignUp(email: string, code: string): Promise<void> {
  return new Promise((resolve, reject) => {
    userFor(email).confirmRegistration(code, true, (err) =>
      err ? reject(err) : resolve()
    )
  })
}

export function signIn(email: string, password: string): Promise<void> {
  return new Promise((resolve, reject) => {
    userFor(email).authenticateUser(
      new AuthenticationDetails({ Username: email, Password: password }),
      { onSuccess: () => resolve(), onFailure: reject }
    )
  })
}

export function signOut(): void {
  getPool().getCurrentUser()?.signOut()
}

/**
 * The API's JWT authorizer validates the audience against the app client,
 * which only ID tokens carry. getSession refreshes an expired one.
 */
export function getIdToken(): Promise<string | null> {
  const user = getPool().getCurrentUser()
  if (!user) return Promise.resolve(null)
  return new Promise((resolve) => {
    user.getSession((err: Error | null, session: CognitoUserSession | null) => {
      resolve(
        err || !session?.isValid() ? null : session.getIdToken().getJwtToken()
      )
    })
  })
}

export function currentEmail(): string | null {
  return getPool().getCurrentUser()?.getUsername() ?? null
}
