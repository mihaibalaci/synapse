{{/*
Determine Postgres host based on mode
*/}}
{{- define "db.host" -}}
{{- if eq .Values.postgresql.mode "managed" -}}
{{ .Values.postgresql.host }}
{{- else -}}
{{ .Release.Name }}-patroni
{{- end -}}
{{- end -}}

{{/*
Determine Redis host based on mode
*/}}
{{- define "redis.host" -}}
{{- if eq .Values.redis.mode "managed" -}}
{{ .Values.redis.host }}
{{- else -}}
{{ .Release.Name }}-redis-master
{{- end -}}
{{- end -}}
