import { useState } from 'react'
import { useAppContext } from '../context/AppContext'

export default function PasswordInput({
  showLabel,
  hideLabel,
  wrapperClassName = '',
  ...inputProps
}) {
  const { tr } = useAppContext()
  const [visible, setVisible] = useState(false)
  const label = visible
    ? (hideLabel || tr.hidePassword)
    : (showLabel || tr.showPassword)

  return (
    <div className={`password-input ${wrapperClassName}`.trim()}>
      <input
        {...inputProps}
        type={visible ? 'text' : 'password'}
      />
      <button
        type="button"
        className="password-toggle"
        onClick={() => setVisible(value => !value)}
        aria-label={label}
        title={label}
      >
        {visible ? (
          <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18" aria-hidden="true">
            <path d="M2.1 3.51 3.51 2.1 21.9 20.49l-1.41 1.41-3.06-3.06A11.85 11.85 0 0 1 12 20C7 20 2.73 16.89 1 12.5a11.73 11.73 0 0 1 4.07-5.25L2.1 3.51Zm7.54 7.54a2.64 2.64 0 0 0-.14.95 2.5 2.5 0 0 0 2.5 2.5c.33 0 .65-.06.95-.18l-3.31-3.27ZM12 5c5 0 9.27 3.11 11 7.5a11.78 11.78 0 0 1-3.05 4.28l-2.84-2.84A5.43 5.43 0 0 0 17.5 12 5.5 5.5 0 0 0 12 6.5c-.68 0-1.33.12-1.93.35L7.88 4.66A12 12 0 0 1 12 5Zm-.24 2.52L16.48 12v-.02A4.48 4.48 0 0 0 12 7.5h-.24Z" />
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18" aria-hidden="true">
            <path d="M12 5c5 0 9.27 3.11 11 7.5C21.27 16.89 17 20 12 20S2.73 16.89 1 12.5C2.73 8.11 7 5 12 5Zm0 2C8.24 7 4.96 9.12 3.19 12.5 4.96 15.88 8.24 18 12 18s7.04-2.12 8.81-5.5C19.04 9.12 15.76 7 12 7Zm0 2a3.5 3.5 0 1 1 0 7 3.5 3.5 0 0 1 0-7Zm0 2a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Z" />
          </svg>
        )}
      </button>
    </div>
  )
}
