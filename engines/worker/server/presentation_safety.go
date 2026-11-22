package server

import (
	"net"
	"net/url"
	"regexp"
	"strings"
)

// Presentation data is user-facing data. Workers may legitimately record
// credentials, internal addresses, and service probes while testing, but those
// values must not be echoed into the customer console or a browser payload.
var (
	presentationSecretAssignment = regexp.MustCompile(`(?i)\b(OPENAI_API_KEY|ANTHROPIC_API_KEY|GHOSTWIRE_[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|DSN)|[A-Z0-9_]*(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|PASSWORD|SECRET|PRIVATE_KEY|DSN))\b(\s*(?::|=|\s)\s*)[^\s,;\)\]\}]{8,}`)
	presentationNaturalSecret    = regexp.MustCompile(`(?i)\b(password|passwd|pwd|secret|token|api[-_ ]?key|private key)\b\s*(?::|=|is|was|of)?\s*[A-Za-z0-9_./+=:-]{8,}`)
	presentationJWT              = regexp.MustCompile(`\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b`)
	presentationProviderKey      = regexp.MustCompile(`\b(?:sk|rk)-[A-Za-z0-9_-]{16,}\b`)
	presentationBearer           = regexp.MustCompile(`(?i)(\bBearer\s+)[^\s,;\)\]\}]+`)
	presentationDSN              = regexp.MustCompile(`(?i)\b(?:postgres(?:ql)?|mysql|redis)://[^\s,;\)\]\}]+`)
	presentationPrivateIPv4      = regexp.MustCompile(`\b(10\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}|127\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}|169\.254\.[0-9]{1,3}\.[0-9]{1,3}|192\.168\.[0-9]{1,3}\.[0-9]{1,3}|172\.(16|17|18|19|2[0-9]|3[0-1])\.[0-9]{1,3}\.[0-9]{1,3})\b`)
	presentationSensitivePath    = regexp.MustCompile(`(?i)(?:^|/)(?:install\.sh|metrics|ssh|artex)(?:/|$|\?)`)
)

func redactSensitiveText(value string) string {
	if value == "" {
		return value
	}
	value = presentationSecretAssignment.ReplaceAllString(value, "$1$2[redacted]")
	value = presentationNaturalSecret.ReplaceAllString(value, "$1 [redacted]")
	value = presentationJWT.ReplaceAllString(value, "[JWT redacted]")
	value = presentationProviderKey.ReplaceAllString(value, "[provider key redacted]")
	value = presentationBearer.ReplaceAllString(value, "$1[redacted]")
	value = presentationDSN.ReplaceAllString(value, "[database connection redacted]")
	value = presentationPrivateIPv4.ReplaceAllString(value, "[internal address]")
	return value
}

func privateOrLocalHost(host string) bool {
	host = strings.TrimSpace(strings.Trim(host, "[]"))
	if parsed, _, err := net.SplitHostPort(host); err == nil {
		host = parsed
	}
	if host == "" || strings.EqualFold(host, "localhost") || strings.HasSuffix(strings.ToLower(host), ".local") || strings.HasSuffix(strings.ToLower(host), ".internal") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && (ip.IsPrivate() || ip.IsLoopback() || ip.IsLinkLocalUnicast())
}

// safeTrafficTarget removes private target identity and explicit service ports
// from compact traffic summaries. The detailed evidence endpoint applies the
// same policy to headers and body text before returning it to the browser.
func safeTrafficTarget(host, raw string) (string, string) {
	host = strings.TrimSpace(host)
	u, err := url.Parse(strings.TrimSpace(raw))
	parsedHost := host
	if err == nil && u.Hostname() != "" {
		parsedHost = u.Hostname()
	}
	if privateOrLocalHost(parsedHost) {
		return "[internal target]", "internal://target"
	}
	if err != nil || u.Host == "" {
		if parsed, _, splitErr := net.SplitHostPort(parsedHost); splitErr == nil {
			parsedHost = parsed
		}
		return redactSensitiveText(parsedHost), redactSensitiveText(raw)
	}
	u.Host = u.Hostname()
	if presentationSensitivePath.MatchString(u.Path) {
		u.Path = "/[protected endpoint]"
		u.RawQuery = ""
	}
	return redactSensitiveText(parsedHost), redactSensitiveText(u.String())
}

func redactTrafficHTTP(raw string) string {
	if raw == "" {
		return raw
	}
	lines := strings.Split(raw, "\n")
	for i, line := range lines {
		trimmed := strings.TrimRight(line, "\r")
		lower := strings.ToLower(trimmed)
		if strings.HasPrefix(lower, "host:") {
			host, _ := safeTrafficTarget(strings.TrimSpace(trimmed[len("host:"):]), "")
			lines[i] = "Host: " + host
		} else if i == 0 && (strings.HasPrefix(trimmed, "GET ") || strings.HasPrefix(trimmed, "POST ") || strings.HasPrefix(trimmed, "PUT ") || strings.HasPrefix(trimmed, "PATCH ") || strings.HasPrefix(trimmed, "DELETE ") || strings.HasPrefix(trimmed, "HEAD ") || strings.HasPrefix(trimmed, "OPTIONS ")) {
			parts := strings.SplitN(trimmed, " ", 3)
			if len(parts) == 3 {
				_, safeURL := safeTrafficTarget("", parts[1])
				lines[i] = parts[0] + " " + safeURL + " " + parts[2]
			}
		}
	}
	return redactSensitiveText(strings.Join(lines, "\n"))
}
