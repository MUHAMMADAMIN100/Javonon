import { saveAs } from 'file-saver';
import type { Student } from '../api/types';
import { DIRECTION_LABEL, STUDENT_STATUS_LABEL } from '../api/types';

const fmtDate = (iso: string) => new Date(iso).toLocaleDateString('ru-RU');

export async function generateStudentsReport(params: {
  students: Student[];
  from: string;
  to: string;
}) {
  const { students, from, to } = params;

  const {
    Document,
    Packer,
    Paragraph,
    TextRun,
    HeadingLevel,
    AlignmentType,
    Table,
    TableRow,
    TableCell,
    WidthType,
    BorderStyle,
    ShadingType,
    PageOrientation,
    Header,
    Footer,
    PageNumber,
  } = await import('docx');

  const periodText = `за период ${fmtDate(from)} — ${fmtDate(to)}`;
  const generatedAt = new Date().toLocaleString('ru-RU');

  const byStatus = students.reduce<Record<string, number>>((acc, s) => {
    acc[s.status] = (acc[s.status] || 0) + 1;
    return acc;
  }, {});
  // Студенты, приехавшие из заявок с лендинга, до подтверждения направления
  // держат в direction плейсхолдер бэкенда (BACHELOR). В отчёте, который
  // уходит наружу, такой студент не должен считаться бакалавром — иначе
  // «По направлениям» показывает выдуманную структуру потока. Сводим их
  // в отдельную строку.
  const DIRECTION_UNCONFIRMED_KEY = '__unconfirmed__';
  const DIRECTION_UNCONFIRMED_LABEL = 'Направление не подтверждено';
  const byDirection = students.reduce<Record<string, number>>((acc, s) => {
    const key = s.directionConfirmed === false ? DIRECTION_UNCONFIRMED_KEY : s.direction;
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});

  const BORDER = { style: BorderStyle.SINGLE, size: 4, color: 'D5D9DF' };
  const cellBorders = { top: BORDER, bottom: BORDER, left: BORDER, right: BORDER };
  const cellMargins = { top: 80, bottom: 80, left: 100, right: 100 };

  // Ширина страницы A4 landscape = 16838 twips; минус margins 720*2 = 720
  // ⇒ доступная ширина для таблицы 15398 twips. Округляем до 15400.
  const TABLE_WIDTH = 15400;
  // Доли колонок — сумма ровно 1.0, проценты выбраны под реальный контент:
  // длинные ФИО и Менеджер шире, № и Кабинет узкие.
  const COL_RATIOS = [0.04, 0.22, 0.13, 0.06, 0.10, 0.13, 0.18, 0.14];
  const COL_WIDTHS = COL_RATIOS.map((r) => Math.round(TABLE_WIDTH * r));

  const headerCell = (text: string, colIdx: number) =>
    new TableCell({
      width: { size: COL_WIDTHS[colIdx], type: WidthType.DXA },
      borders: cellBorders,
      margins: cellMargins,
      shading: { type: ShadingType.CLEAR, color: 'auto', fill: 'D52B2B' },
      children: [
        new Paragraph({
          alignment: AlignmentType.LEFT,
          children: [new TextRun({ text, bold: true, color: 'FFFFFF', size: 18 })],
        }),
      ],
    });

  const bodyCell = (text: string, colIdx: number, alt = false) =>
    new TableCell({
      width: { size: COL_WIDTHS[colIdx], type: WidthType.DXA },
      borders: cellBorders,
      margins: cellMargins,
      shading: alt ? { type: ShadingType.CLEAR, color: 'auto', fill: 'F8FAFC' } : undefined,
      children: [
        new Paragraph({
          children: [new TextRun({ text: text || '—', size: 16 })],
        }),
      ],
    });

  const tableRows: InstanceType<typeof TableRow>[] = [
    new TableRow({
      tableHeader: true,
      children: [
        headerCell('№', 0),
        headerCell('ФИО', 1),
        headerCell('Направление', 2),
        headerCell('Кабинет', 3),
        headerCell('Статус', 4),
        headerCell('Телефон', 5),
        headerCell('Менеджер', 6),
        headerCell('Дата', 7),
      ],
    }),
    ...students.map(
      (s, i) =>
        new TableRow({
          children: [
            bodyCell(String(i + 1), 0, i % 2 === 1),
            bodyCell(s.fullName, 1, i % 2 === 1),
            // Прочерк, а не «Бакалавриат»: направление ещё не подтверждено
            // человеком (см. byDirection выше).
            bodyCell(
              s.directionConfirmed === false ? '—' : DIRECTION_LABEL[s.direction],
              2,
              i % 2 === 1,
            ),
            bodyCell(String(s.cabinet), 3, i % 2 === 1),
            bodyCell(STUDENT_STATUS_LABEL[s.status], 4, i % 2 === 1),
            bodyCell(s.phones.join(', '), 5, i % 2 === 1),
            bodyCell(s.manager?.fullName || '—', 6, i % 2 === 1),
            bodyCell(fmtDate(s.createdAt), 7, i % 2 === 1),
          ],
        }),
    ),
  ];

  const doc = new Document({
    creator: 'Javonon CRM',
    title: `Отчёт по студентам ${periodText}`,
    styles: {
      default: {
        document: {
          run: { font: 'Calibri', size: 20 },
        },
      },
    },
    sections: [
      {
        properties: {
          page: {
            size: { orientation: PageOrientation.LANDSCAPE },
            margin: { top: 720, bottom: 720, left: 720, right: 720 },
          },
        },
        headers: {
          default: new Header({
            children: [
              new Paragraph({
                alignment: AlignmentType.RIGHT,
                children: [
                  new TextRun({ text: 'Javonon — Отчёт по студентам', color: '888888', size: 16 }),
                ],
              }),
            ],
          }),
        },
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                children: [
                  new TextRun({ text: `Сформировано: ${generatedAt}`, color: '888888', size: 16 }),
                  new TextRun({ text: '\tСтр. ', color: '888888', size: 16 }),
                  new TextRun({ children: [PageNumber.CURRENT], color: '888888', size: 16 }),
                  new TextRun({ text: ' из ', color: '888888', size: 16 }),
                  new TextRun({ children: [PageNumber.TOTAL_PAGES], color: '888888', size: 16 }),
                ],
              }),
            ],
          }),
        },
        children: [
          new Paragraph({
            children: [new TextRun({ text: 'Javonon', bold: true, color: '047857', size: 40 })],
          }),
          new Paragraph({
            heading: HeadingLevel.HEADING_1,
            children: [new TextRun({ text: 'Отчёт по студентам', bold: true, size: 32 })],
          }),
          new Paragraph({
            children: [new TextRun({ text: periodText, color: '5B6478', size: 22 })],
            spacing: { after: 240 },
          }),

          new Paragraph({
            children: [new TextRun({ text: `Всего студентов: ${students.length}`, bold: true, size: 22 })],
          }),
          new Paragraph({
            children: [new TextRun({ text: 'По статусам:', bold: true, size: 20 })],
            spacing: { before: 100 },
          }),
          ...Object.entries(byStatus).map(
            ([k, v]) =>
              new Paragraph({
                children: [
                  new TextRun({
                    text: `  • ${STUDENT_STATUS_LABEL[k as keyof typeof STUDENT_STATUS_LABEL] || k}: ${v}`,
                    size: 20,
                    color: '5B6478',
                  }),
                ],
              }),
          ),
          new Paragraph({
            children: [new TextRun({ text: 'По направлениям:', bold: true, size: 20 })],
            spacing: { before: 100 },
          }),
          ...Object.entries(byDirection).map(
            ([k, v]) =>
              new Paragraph({
                children: [
                  new TextRun({
                    text: `  • ${
                      k === DIRECTION_UNCONFIRMED_KEY
                        ? DIRECTION_UNCONFIRMED_LABEL
                        : DIRECTION_LABEL[k as keyof typeof DIRECTION_LABEL] || k
                    }: ${v}`,
                    size: 20,
                    color: '5B6478',
                  }),
                ],
              }),
          ),
          new Paragraph({ text: '', spacing: { after: 200 } }),

          new Table({
            // Явная ширина в DXA + columnWidths — иначе Word схлопывает
            // колонки до min-content (по букве на строку).
            width: { size: TABLE_WIDTH, type: WidthType.DXA },
            columnWidths: COL_WIDTHS,
            rows: tableRows,
          }),
        ],
      },
    ],
  });

  const blob = await Packer.toBlob(doc);
  const fileName = `javonon-students-${new Date().toISOString().slice(0, 10)}.docx`;
  saveAs(blob, fileName);
}
