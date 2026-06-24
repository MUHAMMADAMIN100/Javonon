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
    // window.history.length > 1 не всегда надёжно (включает первую загрузку),
    // но если есть state.idx > 0 — точно есть куда назад. Берём простой
    // эвристический вариант: пробуем navigate(-1), если страница не сменится
    // — браузер сам проигнорирует.
    if (window.history.length > 1) {
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
