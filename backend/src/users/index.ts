export { UsersService } from './users.service';
export { UsersModule } from './users.module';
export { hasManagerPrivileges, hasAdminPrivileges, roleAtLeast } from './permissions';
export {
  validatePrimaryAdminEmail,
  EMAIL_MIN_LENGTH,
  EMAIL_MAX_LENGTH,
  type EmailValidationResult,
} from './email-validation';
export { validateAvatar, SUPPORTED_AVATAR_MIME_TYPES, type AvatarValidationResult } from './avatar';
export {
  AVATAR_STORAGE,
  FileSystemAvatarStorage,
  type AvatarStorage,
  type AvatarContent,
} from './avatar-storage';
export { type ProfilePatch, type UploadedFile, type MaxProfile } from './profile.types';
