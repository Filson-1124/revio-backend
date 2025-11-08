# Base image with Python
FROM python:3.13-slim

# Set working directory
WORKDIR /app

# Install system dependencies
RUN apt-get update && apt-get install -y \
    pandoc \
    poppler-utils \
    tesseract-ocr \
    nodejs \
    npm \
    g++ \
    && rm -rf /var/lib/apt/lists/*

# Copy Node files and install
COPY package*.json ./
RUN npm install --production

# Copy Python requirements and install
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# Copy app source
COPY . .

# Expose backend port
EXPOSE 5000

# Start Node server
CMD ["node", "index.js"]
