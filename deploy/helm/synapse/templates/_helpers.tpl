{{- define "synapse.image" -}}
{{- $registry := trimSuffix "/" .root.Values.global.imageRegistry -}}
{{- if $registry }}{{ $registry }}/{{ .image.repository }}:{{ .image.tag }}{{ else }}{{ .image.repository }}:{{ .image.tag }}{{ end -}}
{{- end -}}

{{- define "synapse.serviceAccountName" -}}
{{- if .Values.serviceAccount.name }}{{ .Values.serviceAccount.name }}{{ else }}{{ .Release.Name }}{{ end -}}
{{- end -}}

{{- define "synapse.runtimeSecretName" -}}
{{- if .Values.runtimeSecret.name }}{{ .Values.runtimeSecret.name }}{{ else }}{{ .Release.Name }}-runtime{{ end -}}
{{- end -}}

{{- define "synapse.validate" -}}
{{- if eq .Values.postgresql.mode "internal" }}{{ fail "postgresql.mode=internal is unsupported by the application chart; deploy Patroni separately and use managed" }}{{ end -}}
{{- if eq .Values.redis.mode "internal" }}{{ fail "redis.mode=internal is unsupported by the application chart; deploy Redis separately and use managed" }}{{ end -}}
{{- if or (eq .Values.api.image.tag "latest") (eq .Values.worker.image.tag "latest") }}{{ fail "mutable latest image tags are forbidden" }}{{ end -}}
{{- if ne (int .Values.embedding.openai.dimensions) 1536 }}{{ fail "OpenAI embeddings must be 1536-dimensional" }}{{ end -}}
{{- if ne (int .Values.embedding.selfHosted.dimensions) 1536 }}{{ fail "self-hosted embeddings must be 1536-dimensional" }}{{ end -}}
{{- if and (eq .Values.secrets.provider "external-secrets") (not .Values.secrets.externalSecrets.secretStore) }}{{ fail "externalSecrets.secretStore is required" }}{{ end -}}
{{- end -}}
