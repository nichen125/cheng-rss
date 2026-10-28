// UI 验收脚本共用的"怎么进配置"步骤。
//
// 为什么抽出来：v1.13 把侧栏的「订阅」入口删掉了（§15.15 规格修订），
// 配置的唯一入口变成「侧栏底部的齿轮」和「手机底部导航的『配置』」。
// 在此之前有 5 个脚本各自写了一份「找一个含『订阅』的 .nav-item 点它」，
// 这类查找一旦失效，报出来的都是"点不到"这种和真正原因无关的话。
//
// 这里只做**用户动作**的封装（点哪个、等多久），不做断言 ——
// 断言留在各脚本里，失败信息才有意义。

/**
 * 打开配置弹窗。
 *
 * @param {(expr: string) => Promise<any>} ev  各脚本自己的 Runtime.evaluate 包装
 * @param {object} [opts]
 * @param {boolean} [opts.mobile]  true = 点手机底部导航的「配置」，否则点侧栏齿轮
 * @param {string}  [opts.section] 打开后要停在哪个分类（『订阅』/『分组』/…）；
 *                                 不给则不动，停在当前记忆的分类
 * @param {(ms:number)=>Promise<void>} [opts.sleep]
 * @returns {Promise<{opened: boolean, section: string|null}>}
 */
export async function openSettings(ev, opts = {}) {
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));

  // 选择器按"用户眼睛看到的东西"来定，不按实现细节猜：
  //   桌面 = 侧栏右下角那颗齿轮（title 里带「配置」的 icon-btn）
  //   手机 = 底部导航里写着「配置」的那一格
  // 不用 `.sidebar-foot .icon-btn` 这种写法，是因为侧栏底部以后
  // 再挂第二个图标按钮时，它会静默选中错的那个。
  const opened = await ev(opts.mobile
    ? `(() => {
        const b = [...document.querySelectorAll('.tab')]
          .find((x) => (x.textContent || '').trim() === '配置');
        if (!b) return false;
        b.click();
        return true;
      })()`
    : `(() => {
        const b = [...document.querySelectorAll('.icon-btn')]
          .find((x) => (x.getAttribute('title') || '').includes('配置'));
        if (!b) return false;
        b.click();
        return true;
      })()`);
  await sleep(1400);

  let section = null;
  if (opts.section) {
    const ok = await ev(`(() => {
      const b = [...document.querySelectorAll('.settings-nav-item')]
        .find((x) => (x.textContent || '').trim().includes(${JSON.stringify(opts.section)}));
      if (!b) return false;
      b.click();
      return true;
    })()`);
    await sleep(700);
    if (ok) {
      section = await ev(
        `(document.querySelector('.settings-nav-item.active .settings-nav-label')?.textContent ?? '').trim() || null`,
      );
    }
  }

  return { opened: Boolean(opened), section };
}

/**
 * 关掉配置弹窗（Esc）。用真实键盘事件而不是点 ✕ ——
 * 两条路都要通，但 Esc 是脚本里更稳的一条（不受遮罩动画影响）。
 */
export async function closeSettings(send, sleep) {
  await send('Input.dispatchKeyEvent', {
    type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27,
  });
  await send('Input.dispatchKeyEvent', {
    type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27,
  });
  await sleep(700);
}
