FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates libgomp1 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY server .
COPY lib/libonnxruntime.so ./lib/
COPY index.html .
COPY html/ ./html/
COPY legal/ ./legal/
COPY dx7_codebook.bin dx7_codebook_timbre.bin ./

RUN chmod +x server && mkdir -p exports

EXPOSE 8080

ENTRYPOINT ["./server"]
CMD ["-port", "8080", "-generations", "20", "-population", "64"]
