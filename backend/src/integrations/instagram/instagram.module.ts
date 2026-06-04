import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { InstagramService } from './instagram.service';
import { InstagramController } from './instagram.controller';

@Module({
  imports: [PrismaModule],
  providers: [InstagramService],
  controllers: [InstagramController],
  exports: [InstagramService],
})
export class InstagramModule {}
