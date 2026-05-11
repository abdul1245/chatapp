export const maskEmail = email => {
  const value = String(email || '').trim()
  const atIndex = value.indexOf('@')
  if (atIndex <= 0) return value

  const local = value.slice(0, atIndex)
  const domain = value.slice(atIndex)
  if (local.length <= 2) return `${local}${domain}`

  return `${local[0]}${'*'.repeat(local.length - 2)}${local[local.length - 1]}${domain}`
}
