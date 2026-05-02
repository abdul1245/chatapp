import { Component } from 'react'
import { t } from '../i18n'

export default class ErrorBoundary extends Component {
  state = { error: null }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error, info) {
    console.error('App render failed:', error, info)
  }

  render() {
    if (this.state.error) {
      const lang = localStorage.getItem('gty_lang') || 'en'
      const tr = t[lang] || t.en
      return (
        <div className="auth-page">
          <div className="auth-card">
            <h1 className="auth-title">{tr.errorTitle}</h1>
            <p className="auth-subtitle">{this.state.error.message || tr.errorDesc}</p>
            <button className="btn-primary" onClick={() => window.location.reload()}>
              {tr.reload}
            </button>
          </div>
        </div>
      )
    }

    return this.props.children
  }
}
