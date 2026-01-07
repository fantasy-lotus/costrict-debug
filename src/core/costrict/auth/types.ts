/**
 * Authentication module type definitions
 */

// import { CloudUserInfo } from "@roo-code/types"

/**
 * Login status interface
 */
export interface ZgsmLoginState {
	/** Login status identifier */
	state: string

	status?: ZgsmAuthStatus

	/** Machine identifier */
	machineId?: string
}

/**
 * Authentication token interface
 */
export interface ZgsmAuthTokens {
	/** Access token */
	access_token: string
	/** Refresh token */
	refresh_token: string
	/** Local state marker */
	state: string
}

/**
 * Authentication status enum
 */
export enum ZgsmAuthStatus {
	/** Not logged in */
	NOT_LOGGED_IN = "not_logged_in",
	/** Logging in */
	LOGGING_IN = "logging_in",
	/** Logged in */
	LOGGED_IN = "logged_in",
	/** Login failed */
	LOGIN_FAILED = "login_failed",
	/** Token expired */
	TOKEN_EXPIRED = "token_expired",
}

export interface ZgsmLoginResponse {
	success: boolean
	data?: ZgsmLoginState
	message?: string
	code?: string
}

export interface LoginTokenResponse {
	success: boolean
	data?: ZgsmAuthTokens
	message?: string
	code?: string
}
