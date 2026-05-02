import { useState } from 'react'
import { useAppContext } from '../context/AppContext'

export default function NewChatModal({ onClose, onCreate }) {
  const { tr } = useAppContext()
  const [phone, setPhone] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const handleSubmit = async e => {
    e.preventDefault()
    setError('')
    setLoading(true)
    const result = await onCreate(phone)
    if (result?.error) setError(result.error)
    setLoading(false)
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2>{tr.newChat}</h2>
          <button className="icon-btn" onClick={onClose}>✕</button>
        </div>
        <form onSubmit={handleSubmit}>
          <div className="field">
            <label>{tr.newChatPhoneLabel}</label>
            <input
              type="text"
              value={phone}
              onChange={e => setPhone(e.target.value)}
              placeholder={tr.newChatPhonePlaceholder}
              autoFocus
              required
            />
          </div>
          {error && <div className="error-banner">{error}</div>}
          <div className="modal-footer">
            <button type="button" className="btn-secondary" onClick={onClose}>
              {tr.cancel}
            </button>
            <button type="submit" className="btn-primary" disabled={loading}>
              {loading ? tr.searching : tr.startChat}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
