import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import Icon from '../Icon';
import { useT } from '../lib/i18n';

type Props = {
  /** Куда возвращаться, если истории нет (например, прямой вход по ссылке). */
  fallback?: string;
  label?: string;
};

/**
 * Кнопка «Назад» — идёт назад по истории браузера. Если истории нет
 * (открыли страницу по прямой ссылке), уводит на fallback (по умолчанию '/').
 */
export default function BackButton({ fallback = '/', label }: Props) {
  const navigate = useNavigate();
  const { t } = useT();
  const text = label ?? t('common.back').replace(/^[←\s]+/, '');

  const onClick = () => {
    // Назад по истории — только если до этой страницы были шаги ВНУТРИ CRM:
    // тогда вернёмся в список с теми же фильтрами, поиском и вкладкой (они в
    // ссылке). react-router нумерует свои записи в history.state.idx; 0 —
    // первая страница CRM в этой вкладке. window.history.length тут не
    // годится: он считает и чужие сайты, и «Назад» уводил из CRM туда,
    // откуда человек пришёл по ссылке.
    const idx = (window.history.state as { idx?: number } | null)?.idx ?? 0;
    if (idx > 0) {
      navigate(-1);
    } else {
      navigate(fallback);
    }
  };

  return (
    <motion.button
      type="button"
      className="btn btn-secondary btn-sm back-btn"
      onClick={onClick}
      whileHover={{ x: -2 }}
      whileTap={{ scale: 0.96 }}
      title={text}
    >
      <Icon name="arrow_back" size={16} />
      {text}
    </motion.button>
  );
}
