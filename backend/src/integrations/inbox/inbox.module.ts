import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { InboxService } from './inbox.service';
import { InboxController } from './inbox.controller';

@Module({
  imports: [PrismaModule],
  providers: [InboxService],
  controllers: [InboxController],
  exports: [InboxService],
})
export class InboxModule {}
