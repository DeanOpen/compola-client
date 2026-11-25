{{- define "compola.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "compola.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{- define "compola.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{ include "compola.selectorLabels" . }}
app.kubernetes.io/version: {{ (.Values.image.tag | default .Chart.AppVersion) | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{- define "compola.selectorLabels" -}}
app.kubernetes.io/name: {{ include "compola.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{- define "compola.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "compola.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{- define "compola.serverName" -}}
{{- printf "%s-server" (include "compola.fullname" .) | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "compola.serverSelectorLabels" -}}
app.kubernetes.io/name: {{ include "compola.name" . }}-server
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/* Where the gateway sends /api, /ws, /media, /upload: the server in this release, or upstream.url. */}}
{{- define "compola.upstream" -}}
{{- if .Values.upstream.url }}
{{- .Values.upstream.url }}
{{- else if .Values.server.enabled }}
{{- printf "http://%s:39218" (include "compola.serverName" .) }}
{{- else }}
{{- fail "Set server.enabled=true (Compola Server on Linux in this release) or upstream.url (a Compola desktop host)." }}
{{- end }}
{{- end }}
