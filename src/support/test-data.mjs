import crypto from 'node:crypto';

export function uniqueUser(prefix = 'pwa') {
    const id = crypto.randomBytes(4).toString('hex');
    return {
        username: `${prefix}_${id}`,
        password: `Chillin!${id}99`,
    };
}

/**
 * Valid minimal 1x1 PNG buffer (used for real R2 image upload E2E tests).
 */
export function samplePngBuffer() {
    return Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
        'base64'
    );
}

/**
 * Multi-chapter UTF-8 TXT book buffer for testing Reader import, R2 cloud library, and progress sync.
 */
export function sampleTxtBookBuffer(titleTag = '测试手记') {
    const chapters = [];
    for (let i = 1; i <= 5; i++) {
        chapters.push(`第${i}章 ${titleTag}的章节 ${i}\n\n` + Array.from(
            { length: 25 },
            (_, p) => `这是第 ${i} 章第 ${p + 1} 段正文内容，用于验证 Chillin TXT 阅读器分章、排版字号调节与云端阅读进度同步。`
        ).join('\n\n'));
    }
    return Buffer.from(chapters.join('\n\n'), 'utf8');
}
