import { Module } from '@nestjs/common'
import { SecretStoreService } from './secret-store.service.js'

@Module({
  providers: [SecretStoreService],
  exports: [SecretStoreService],
})
export class SecretsModule {}
