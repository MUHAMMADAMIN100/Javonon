import { useState, forwardRef } from 'react';
import type { InputHTMLAttributes } from 'react';
import Icon from '../Icon';

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>;

/**
 * Инпут пароля с кнопкой-«глазком» для переключения видимости.
 * Drop-in замена `<input type="password">`. Иконка появляется внутри
 * поля справа; padding-right увеличен, чтобы текст не наезжал.
 */
const PasswordInput = forwardRef<HTMLInputElement, Props>(function PasswordInput(
  { className, style, ...rest },
  ref,
) {
  const [show, setShow] = useState(false);
  return (
    <div className="password-input-wrap">
      <input
        ref={ref}
        type={show ? 'text' : 'password'}
        className={className}
        style={{ paddingRight: 40, ...style }}
        {...rest}
      />
      <button
        type="button"
        className="password-toggle"
        onClick={() => setShow((s) => !s)}
        aria-label={show ? 'Паролро пинҳон кардан' : 'Паролро нишон додан'}
        tabIndex={-1}
      >
        <Icon name={show ? 'visibility_off' : 'visibility'} size={20} />
      </button>
    </div>
  );
});

export default PasswordInput;
