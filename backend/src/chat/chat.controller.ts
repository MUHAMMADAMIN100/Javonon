import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { ChatService } from './chat.service';

@Controller('chat')
@UseGuards(JwtAuthGuard)
export class ChatController {
  constructor(private svc: ChatService) {}

  @Get('rooms')
  rooms(@CurrentUser() me: any) {
    return this.svc.listRooms(me.id);
  }

  @Get('unread')
  unread(@CurrentUser() me: any) {
    return this.svc.unreadCounts(me.id);
  }

  @Get('rooms/:id')
  room(@Param('id') id: string, @CurrentUser() me: any) {
    return this.svc.getRoom(id, me.id);
  }

  @Post('rooms/:id/messages')
  send(
    @Param('id') id: string,
    @CurrentUser() me: any,
    @Body() body: { text: string; mentionsIds?: string[] },
  ) {
    return this.svc.sendMessage(id, me.id, body.text, body.mentionsIds || []);
  }

  @Post('rooms/team')
  createTeam(
    @CurrentUser() me: any,
    @Body() body: { title: string; memberIds: string[] },
  ) {
    return this.svc.createTeamRoom(me.id, body.title, body.memberIds || []);
  }

  @Post('rooms/direct')
  createDirect(
    @CurrentUser() me: any,
    @Body() body: { userId: string },
  ) {
    return this.svc.createDirectRoom(me.id, body.userId);
  }
}
