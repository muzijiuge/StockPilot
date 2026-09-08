const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  parseTonghuashunCommunityComment,
  parseTonghuashunCommunityPost,
  parseTonghuashunCommunityPostDetail
} = require('../out/dataService');

const root = path.resolve(__dirname, '..');
const dataServiceSource = fs.readFileSync(path.join(root, 'src', 'dataService.ts'), 'utf8');
const sidebarViewSource = fs.readFileSync(path.join(root, 'src', 'sidebarView.ts'), 'utf8');
const sidebarScript = fs.readFileSync(path.join(root, 'media', 'sidebar.js'), 'utf8');
const sidebarCss = fs.readFileSync(path.join(root, 'media', 'sidebar.css'), 'utf8');

const post = parseTonghuashunCommunityPost({
  info: {
    id: 'post-1',
    ctime: 1_700_000_000,
    jump_url: 'https://t.10jqka.com.cn/post/1'
  },
  author: {
    name: '测试用户',
    avatar: 'https://u.thsi.cn/avatar.png'
  },
  title: { content: '标题' },
  abstract: {
    content:
      '<hx_stock>stockName:招商银行,stockCode:600036,market:17</hx_stock><br>正文<img title="[赞]">'
  },
  image: {
    urls: ['https://i.thsi.cn/photo.jpg', 'https://evil.example/image.jpg']
  },
  stat: { like_num: 12, comment_num: 4, forward_num: 2 },
  tag: { tags: [{ name: '招商银行' }] }
});

assert(post, 'a valid feed item should be parsed');
assert.equal(post.id, 'post-1');
assert.equal(post.contentId, '');
assert.equal(post.author, '测试用户');
assert.equal(post.publishedAt, 1_700_000_000_000);
assert.equal(post.content, '$招商银行(600036)$\n正文[赞]');
assert.deepEqual(post.images, ['https://i.thsi.cn/photo.jpg']);
assert.deepEqual(post.tags, ['招商银行']);
assert.equal(post.commentCount, 4);
assert.equal(post.url, 'https://t.10jqka.com.cn/post/1');

const detail = parseTonghuashunCommunityPostDetail(
  {
    status_code: 0,
    data: {
      post: {
        id: 2400627977,
        content_id: '1envufk0olbu2f4b8f935b',
        content: '<span>$招商银行(600036)$</span> 完整正文',
        ctime: 1_700_000_001,
        jump_url:
          'https://c.10jqka.com.cn/m/post/discussDetail/?contentId=1envufk0olbu2f4b8f935b',
        ext: { att_img: { img_urls: ['https://u.thsi.cn/detail.jpg'] } },
        user: { nickname: '详情作者', avatar: 'https://u.thsi.cn/detail-avatar.jpg' },
        forum: { name: '招商银行' },
        stat: { like: 3, reply: 5, forward: 1 },
        ip_location: { province_name: '上海市' }
      }
    }
  },
  post
);
assert.equal(detail.post.id, '2400627977');
assert.equal(detail.post.contentId, '1envufk0olbu2f4b8f935b');
assert.equal(detail.post.content, '$招商银行(600036)$ 完整正文');
assert.deepEqual(detail.post.images, ['https://u.thsi.cn/detail.jpg']);
assert.equal(detail.ipLocation, '上海市');

const comment = parseTonghuashunCommunityComment({
  id: 9,
  content: '主评论',
  ctime: 1_700_000_002,
  reply_num: 2,
  from_user: { nickname: '评论者', is_article_author: 1 },
  child_comments: [
    {
      id: 10,
      content: '楼中楼',
      ctime: 1_700_000_003,
      from_user: { nickname: '回复者' },
      in_reply_to_user: { nickname: '评论者' }
    }
  ]
});
assert(comment);
assert.equal(comment.replyCount, 2);
assert.equal(comment.replies.length, 1);
assert.equal(comment.replies[0].replyTo, '评论者');
assert.equal(comment.isAuthor, true);

assert.match(dataServiceSource, /content\/v1\/' \+\s*endpoint/);
assert.match(dataServiceSource, /endpoint = 'hot_feed'/);
assert.match(dataServiceSource, /pageSize: '15'/);
assert.match(dataServiceSource, /next\.buffered = buffered/);
assert.match(dataServiceSource, /community_biz_type[\s\S]*!== 1/);
assert.match(dataServiceSource, /post\/info\/get\?content_id=/);
assert.match(dataServiceSource, /comment\/v3\/list/);
assert.match(dataServiceSource, /comment\/v3\/child_list/);
assert.match(sidebarViewSource, /getCommunityPosts\([\s\S]*20/);
assert.match(sidebarViewSource, /data-context-action="community"/);
assert.match(sidebarViewSource, /id="communityBack"/);
assert.match(sidebarViewSource, /id="communityRefresh"/);
assert.match(sidebarViewSource, /id="communityDetailPage"/);
assert.match(sidebarViewSource, /loadMoreCommunityComments/);
assert.match(sidebarViewSource, /loadCommunityReplies/);
assert.doesNotMatch(sidebarViewSource, /data-community-sort|communitySortMenu/);
assert.match(sidebarScript, /new IntersectionObserver/);
assert.match(sidebarScript, /type: 'loadMoreCommunity'/);
assert.match(sidebarScript, /type: 'loadMoreCommunityComments'/);
assert.match(sidebarScript, /data-community-replies-root/);
assert.match(sidebarCss, /\.community-feed\s*\{[\s\S]*column-count:\s*1/);
assert.match(sidebarCss, /@media \(min-width: 460px\)[\s\S]*column-count:\s*2/);

console.log(
  JSON.stringify({
    readOnlyCommunity: true,
    inSidebarPostDetail: true,
    nestedCommentPaging: true,
    initialPageSize: 20,
    upstreamPageSize: 15,
    infiniteScroll: true,
    sortModes: ['hot'],
    waterfallColumns: [1, 2]
  })
);
