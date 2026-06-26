export { AuthService } from './auth.service';
export { AuthModule } from './auth.module';
export { PasswordService } from './password.service';
export { PasswordSetupTokenService } from './password-setup-token.service';
export { SessionTokenService } from './session-token.service';
export { SessionAuthGuard, type AuthenticatedRequest } from './session-auth.guard';
export {
  SESSION_DISCONNECTOR,
  SESSION_REVOKED_EVENT,
  NoopSessionDisconnector,
  SocketSessionDisconnector,
  personaRoom,
  type SessionDisconnector,
} from './session-disconnector';
export { type AccessTokenPayload, type AuthPrincipal, type AuthSession } from './auth.types';
export { validatePasswordLength, type PasswordValidationResult } from './password';
