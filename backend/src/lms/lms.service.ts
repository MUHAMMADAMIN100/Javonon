import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class LmsService {
  constructor(private prisma: PrismaService) {}

  // ==================== COURSES (admin) ====================

  async listCourses(opts: { onlyPublished?: boolean } = {}) {
    return this.prisma.course.findMany({
      where: opts.onlyPublished ? { published: true } : undefined,
      orderBy: { createdAt: 'desc' },
      include: {
        _count: { select: { lessons: true, enrollments: true } },
        author: { select: { id: true, fullName: true } },
      },
    });
  }

  async getCourse(id: string) {
    const course = await this.prisma.course.findUnique({
      where: { id },
      include: {
        lessons: { orderBy: { order: 'asc' } },
        author: { select: { id: true, fullName: true } },
      },
    });
    if (!course) throw new NotFoundException('Курс не найден');
    return course;
  }

  async createCourse(authorId: string, dto: { title: string; description?: string; coverUrl?: string }) {
    if (!dto.title?.trim()) throw new BadRequestException('Название обязательно');
    return this.prisma.course.create({
      data: {
        title: dto.title.trim(),
        description: dto.description?.trim() || null,
        coverUrl: dto.coverUrl || null,
        authorId,
      },
    });
  }

  async updateCourse(id: string, dto: Partial<{ title: string; description: string; coverUrl: string; published: boolean }>) {
    return this.prisma.course.update({ where: { id }, data: dto });
  }

  async deleteCourse(id: string) {
    // Cascade cleanup: курс может иметь lessons + enrollments + lessonProgress
    // Schema не имеет onDelete: Cascade, поэтому удаляем вручную в транзакции,
    // иначе Prisma бросит P2003 (foreign key violation) или оставит orphan rows.
    return this.prisma.$transaction(async (tx) => {
      // Все уроки этого курса
      const lessons = await tx.lesson.findMany({
        where: { courseId: id },
        select: { id: true },
      });
      const lessonIds = lessons.map((l) => l.id);
      if (lessonIds.length) {
        await tx.lessonProgress.deleteMany({ where: { lessonId: { in: lessonIds } } });
        await tx.lesson.deleteMany({ where: { courseId: id } });
      }
      await tx.enrollment.deleteMany({ where: { courseId: id } });
      return tx.course.delete({ where: { id } });
    });
  }

  // ==================== LESSONS ====================

  async createLesson(courseId: string, dto: { title: string; content?: string; videoUrl?: string; attachmentUrl?: string; order?: number }) {
    if (!dto.title?.trim()) throw new BadRequestException('Название урока обязательно');
    const last = await this.prisma.lesson.findFirst({
      where: { courseId },
      orderBy: { order: 'desc' },
    });
    return this.prisma.lesson.create({
      data: {
        courseId,
        title: dto.title.trim(),
        content: dto.content?.trim() || null,
        videoUrl: dto.videoUrl || null,
        attachmentUrl: dto.attachmentUrl || null,
        order: dto.order ?? (last ? last.order + 1 : 0),
      },
    });
  }

  async updateLesson(id: string, dto: Partial<{ title: string; content: string; videoUrl: string; attachmentUrl: string; order: number }>) {
    return this.prisma.lesson.update({ where: { id }, data: dto });
  }

  async deleteLesson(id: string) {
    return this.prisma.lesson.delete({ where: { id } });
  }

  // ==================== ENROLLMENTS / PROGRESS (student) ====================

  async studentCourses(studentId: string) {
    const enrollments = await this.prisma.enrollment.findMany({
      where: { studentId },
      include: {
        course: {
          include: {
            lessons: { select: { id: true } },
            _count: { select: { lessons: true } },
          },
        },
      },
      orderBy: { enrolledAt: 'desc' },
    });

    const result = await Promise.all(enrollments.map(async (e) => {
      const completed = await this.prisma.lessonProgress.count({
        where: {
          studentId,
          lessonId: { in: e.course.lessons.map((l) => l.id) },
          completed: true,
        },
      });
      return {
        enrollmentId: e.id,
        course: { id: e.course.id, title: e.course.title, coverUrl: e.course.coverUrl, description: e.course.description },
        totalLessons: e.course._count.lessons,
        completedLessons: completed,
        progress: e.course._count.lessons ? Math.round((completed / e.course._count.lessons) * 100) : 0,
        enrolledAt: e.enrolledAt,
        completedAt: e.completedAt,
      };
    }));
    return result;
  }

  async availableCoursesForStudent(studentId: string) {
    const all = await this.listCourses({ onlyPublished: true });
    const enrolledIds = (await this.prisma.enrollment.findMany({
      where: { studentId },
      select: { courseId: true },
    })).map((e) => e.courseId);
    return all.filter((c) => !enrolledIds.includes(c.id));
  }

  async enroll(studentId: string, courseId: string, byAdmin = false) {
    const course = await this.prisma.course.findUnique({
      where: { id: courseId },
      select: { id: true, published: true },
    });
    if (!course) throw new NotFoundException('Курс не найден');
    // QA-fix: студент может записаться только на опубликованный курс.
    // Админ может записать на любой (для подготовки или приватного доступа).
    if (!byAdmin && !course.published) {
      throw new BadRequestException('Курс пока не опубликован');
    }
    return this.prisma.enrollment.upsert({
      where: { courseId_studentId: { courseId, studentId } },
      update: {},
      create: { courseId, studentId },
    });
  }

  async getCourseForStudent(courseId: string, studentId: string) {
    const course = await this.prisma.course.findUnique({
      where: { id: courseId },
      include: { lessons: { orderBy: { order: 'asc' } } },
    });
    if (!course) throw new NotFoundException('Курс не найден');
    const enrollment = await this.prisma.enrollment.findUnique({
      where: { courseId_studentId: { courseId, studentId } },
    });
    const progress = await this.prisma.lessonProgress.findMany({
      where: { studentId, lessonId: { in: course.lessons.map((l) => l.id) } },
    });
    const progressMap = new Map(progress.map((p) => [p.lessonId, p]));

    return {
      ...course,
      enrolled: !!enrollment,
      enrolledAt: enrollment?.enrolledAt || null,
      lessons: course.lessons.map((l) => ({
        ...l,
        completed: progressMap.get(l.id)?.completed || false,
      })),
    };
  }

  async markLessonComplete(lessonId: string, studentId: string) {
    // QA-fix: студент должен быть записан на курс этого урока.
    const lesson = await this.prisma.lesson.findUnique({
      where: { id: lessonId },
      select: { id: true, courseId: true },
    });
    if (!lesson) throw new NotFoundException('Урок не найден');
    const enrollment = await this.prisma.enrollment.findUnique({
      where: { courseId_studentId: { courseId: lesson.courseId, studentId } },
    });
    if (!enrollment) {
      throw new BadRequestException('Сначала запишитесь на курс');
    }
    return this.prisma.lessonProgress.upsert({
      where: { lessonId_studentId: { lessonId, studentId } },
      update: { completed: true, completedAt: new Date() },
      create: { lessonId, studentId, completed: true, completedAt: new Date() },
    });
  }
}
