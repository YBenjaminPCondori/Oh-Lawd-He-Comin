FROM python:3.12-slim-bookworm

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY chonkvid/ ./chonkvid/
COPY web/ ./web/
# results/ and runs/ are gitignored, so a clean clone has neither: create them instead of
# COPYing them, otherwise the image cannot be built from the repository at all
RUN mkdir -p results runs

ENV PYTHONUNBUFFERED=1
ENV CHONKVID_MODE=auto
ENV WHO_MODE=chat
ENV WHO_CONTEXT=full
ENV WHO_VISION=1

EXPOSE 8080

CMD ["python", "-m", "uvicorn", "chonkvid.server:app", "--host", "0.0.0.0", "--port", "8080"]