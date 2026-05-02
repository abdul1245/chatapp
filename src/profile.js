export function buildDisplayName(user) {
  const first = String(user?.name || '').trim()
  const last = String(user?.lastName || '').trim()
  return [first, last].filter(Boolean).join(' ').trim()
}

export function parseBirthday(value) {
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!match) return { year: '', month: '', day: '' }
  return {
    year: match[1],
    month: String(Number(match[2])),
    day: String(Number(match[3])),
  }
}

export function buildBirthday(day, month, year) {
  const dd = String(day || '').trim()
  const mm = String(month || '').trim()
  const yyyy = String(year || '').trim()
  if (!dd || !mm || !yyyy) return ''
  if (!/^\d{1,2}$/.test(dd) || !/^\d{1,2}$/.test(mm) || !/^\d{4}$/.test(yyyy)) return ''

  const dayNum = Number(dd)
  const monthNum = Number(mm)
  const yearNum = Number(yyyy)
  if (monthNum < 1 || monthNum > 12 || dayNum < 1 || yearNum < 1900) return ''

  const date = new Date(yearNum, monthNum - 1, dayNum)
  const valid = date.getFullYear() === yearNum
    && date.getMonth() === monthNum - 1
    && date.getDate() === dayNum
  if (!valid) return ''

  const today = new Date()
  today.setHours(23, 59, 59, 999)
  if (date > today) return ''

  return `${yyyy}-${String(monthNum).padStart(2, '0')}-${String(dayNum).padStart(2, '0')}`
}

export function formatBirthday(value) {
  if (!value) return '-'
  const date = new Date(`${value}T00:00:00`)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString()
}
