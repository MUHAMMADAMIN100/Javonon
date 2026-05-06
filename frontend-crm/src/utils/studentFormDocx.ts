import { FORM_SECTIONS, displayValue } from '../formSchema';

export async function generateStudentFormDocx(studentName: string, form: any): Promise<Blob> {
  const {
    Document,
    Packer,
    Paragraph,
    TextRun,
    Table,
    TableRow,
    TableCell,
    WidthType,
    BorderStyle,
    ShadingType,
    AlignmentType,
  } = await import('docx');

  const BORDER = { style: BorderStyle.SINGLE, size: 4, color: 'D5D9DF' };
  const cellBorders = { top: BORDER, bottom: BORDER, left: BORDER, right: BORDER };

  // Ширина текстового поля страницы в twips: 8.5" - 2*0.5" margins = 7.5" = 10800 twips
  const PAGE_WIDTH_TWIPS = 10800;

  const labelCell = (text: string) =>
    new TableCell({
      borders: cellBorders,
      shading: { type: ShadingType.CLEAR, color: 'auto', fill: 'FFF5F5' },
      margins: { top: 80, bottom: 80, left: 120, right: 120 },
      children: [
        new Paragraph({
          children: [new TextRun({ text, bold: true, size: 18, color: '5B6478' })],
        }),
      ],
    });

  const valueCell = (text: string) =>
    new TableCell({
      borders: cellBorders,
      margins: { top: 80, bottom: 80, left: 120, right: 120 },
      children: [
        new Paragraph({
          children: [new TextRun({ text: text || '—', size: 20 })],
        }),
      ],
    });

  const headerCell = (text: string) =>
    new TableCell({
      borders: cellBorders,
      shading: { type: ShadingType.CLEAR, color: 'auto', fill: 'D52B2B' },
      margins: { top: 80, bottom: 80, left: 120, right: 120 },
      children: [
        new Paragraph({
          children: [new TextRun({ text, bold: true, color: 'FFFFFF', size: 18 })],
        }),
      ],
    });

  const sectionHeading = (text: string, textEn?: string) => [
    new Paragraph({
      spacing: { before: 300, after: 120 },
      children: [
        new TextRun({ text, bold: true, size: 28, color: 'D52B2B' }),
        ...(textEn
          ? [new TextRun({ text: `  ${textEn}`, italics: true, size: 20, color: '888888' })]
          : []),
      ],
    }),
  ];

  const children: any[] = [
    // Шапка
    new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [new TextRun({ text: 'Javonon', bold: true, size: 40, color: '047857' })],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [new TextRun({ text: 'Application Form', bold: true, size: 28 })],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 300 },
      children: [
        new TextRun({
          text: `Student: ${studentName}  ·  Generated: ${new Date().toLocaleDateString('ru-RU')}`,
          size: 18,
          color: '5B6478',
        }),
      ],
    }),
  ];

  for (const section of FORM_SECTIONS) {
    children.push(...sectionHeading(section.title, section.titleEn));

    if (section.fields) {
      // Двухколоночная таблица label / value
      const rows = section.fields.map(
        (f) =>
          new TableRow({
            cantSplit: true,
            children: [
              labelCell(`${f.label}${f.labelEn ? ` (${f.labelEn})` : ''}`),
              valueCell(displayValue(f, form?.[section.key]?.[f.key])),
            ],
          }),
      );
      children.push(
        new Table({
          width: { size: PAGE_WIDTH_TWIPS, type: WidthType.DXA },
          columnWidths: [Math.round(PAGE_WIDTH_TWIPS * 0.35), Math.round(PAGE_WIDTH_TWIPS * 0.65)],
          rows,
        }),
      );
    } else if (section.table) {
      const cols = section.table.columns;
      const rowLabels = section.table.rowLabels;
      const rows: any[] = [];

      // Шапка
      const headerCells = [];
      if (rowLabels) headerCells.push(headerCell('#'));
      for (const c of cols) {
        headerCells.push(headerCell(`${c.label}${c.labelEn ? ` / ${c.labelEn}` : ''}`));
      }
      rows.push(new TableRow({ tableHeader: true, cantSplit: true, children: headerCells }));

      const dataRows = form?.[section.key] || [];
      dataRows.forEach((row: any, ri: number) => {
        // Пропускаем строки, отмеченные как "не учился" — их вообще нет в отчёте.
        if (row?.__notAttended) return;
        const cells = [];
        if (rowLabels) {
          cells.push(
            new TableCell({
              borders: cellBorders,
              shading: { type: ShadingType.CLEAR, color: 'auto', fill: 'FFF5F5' },
              margins: { top: 80, bottom: 80, left: 120, right: 120 },
              children: [
                new Paragraph({
                  children: [
                    new TextRun({
                      text: rowLabels[ri] || `${ri + 1}`,
                      bold: true,
                      size: 16,
                      color: 'D52B2B',
                    }),
                  ],
                }),
              ],
            }),
          );
        }
        for (const c of cols) {
          cells.push(valueCell(displayValue(c, row?.[c.key])));
        }
        rows.push(new TableRow({ cantSplit: true, children: cells }));
      });

      // Расчёт ширины колонок: первая (#) — 18%, остальные равные
      const totalCols = (rowLabels ? 1 : 0) + cols.length;
      const labelW = rowLabels ? Math.round(PAGE_WIDTH_TWIPS * 0.18) : 0;
      const remainW = PAGE_WIDTH_TWIPS - labelW;
      const colW = Math.floor(remainW / cols.length);
      const columnWidths = rowLabels
        ? [labelW, ...Array(cols.length).fill(colW)]
        : Array(totalCols).fill(Math.floor(PAGE_WIDTH_TWIPS / totalCols));

      if (rows.length > 1) {
        children.push(
          new Table({
            width: { size: PAGE_WIDTH_TWIPS, type: WidthType.DXA },
            columnWidths,
            rows,
          }),
        );
      } else {
        children.push(
          new Paragraph({
            children: [new TextRun({ text: '— не заполнено —', italics: true, color: '9CA3AF', size: 18 })],
          }),
        );
      }
    }
  }

  const doc = new Document({
    creator: 'Javonon CRM',
    title: `Application Form — ${studentName}`,
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
          page: { margin: { top: 720, bottom: 720, left: 720, right: 720 } },
        },
        children,
      },
    ],
  });

  return Packer.toBlob(doc);
}
