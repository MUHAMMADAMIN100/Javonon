import { IsDateString, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class CreateTaskDto {
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  title: string;

  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  description: string;

  @IsString()
  assignedToId: string;

  @IsOptional()
  @IsDateString()
  deadline?: string;
}
