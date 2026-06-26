import { Injectable } from '@nestjs/common';

export interface HealthStatus {
  status: 'ok';
  service: string;
}

@Injectable()
export class AppService {
  /** Простая проверка работоспособности приложения. */
  health(): HealthStatus {
    return { status: 'ok', service: 'task-assignment-system' };
  }
}
